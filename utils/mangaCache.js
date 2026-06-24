const { setTimeout: sleep } = require('timers/promises');

let mangaCache = [];
let isInitialized = false;
let isInitializing = false;
let retryTimeout = null;

// Jikan API safety limits.
const DELAY_BETWEEN_REQUESTS = 1500;
const TOTAL_PAGES = 16;
const REQUEST_TIMEOUT_MS = 7000;
const MAX_429_RETRIES_PER_PAGE = 1;
const MAX_CONSECUTIVE_HARD_FAILURES = 4;
const MIN_READY_ITEMS = 50;
const RETRY_ON_FAILURE_MS = 30 * 60 * 1000; // 30 minutes

function scheduleRetry() {
    if (retryTimeout) return;

    console.warn(`[MANGA CACHE] Refresh failed. Scheduling retry in ${Math.floor(RETRY_ON_FAILURE_MS / 60000)} minutes.`);
    retryTimeout = globalThis.setTimeout(() => {
        retryTimeout = null;
        fetchTopManga();
    }, RETRY_ON_FAILURE_MS);

    // Don't keep the process alive just for this retry timer.
    if (typeof retryTimeout.unref === 'function') {
        retryTimeout.unref();
    }
}

async function fetchPage(page) {
    let rateLimitRetries = 0;

    while (true) {
        try {
            const response = await fetch(`https://api.jikan.moe/v4/top/manga?page=${page}&filter=bypopularity&type=manga`, {
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                headers: { 'User-Agent': 'TsunBot/1.0' }
            });

            if (!response.ok) {
                if (response.status === 429 && rateLimitRetries < MAX_429_RETRIES_PER_PAGE) {
                    rateLimitRetries++;
                    await sleep(10000);
                    continue;
                }
                return { ok: false, status: response.status };
            }

            const data = await response.json();
            const list = Array.isArray(data?.data) ? data.data : [];

            const cleanData = list
                .filter(m =>
                    m.score !== null &&
                    m.score !== undefined &&
                    !isNaN(m.score) &&
                    m.images?.jpg?.image_url &&
                    m.titles?.[0]?.title
                )
                .map(m => ({
                    id: m.mal_id,
                    title: m.titles.find(t => t.type === 'Default')?.title || m.title,
                    score: parseFloat(m.score),
                    image: m.images.jpg.large_image_url || m.images.jpg.image_url,
                    rank: m.rank,
                    popularity: m.popularity
                }));

            return { ok: true, items: cleanData };
        } catch (err) {
            return { ok: false, status: 0, error: err?.message || 'unknown error' };
        }
    }
}

/**
 * Fetches top manga from Jikan API.
 * Non-blocking: errors are summarized and do not crash the bot.
 */
async function fetchTopManga() {
    if (isInitializing) return;
    isInitializing = true;

    const startedAt = Date.now();
    const tempCache = [];

    let pagesLoaded = 0;
    let rateLimitedPages = 0;
    let serverErrorPages = 0;
    let networkErrorPages = 0;
    let otherErrorPages = 0;
    let consecutiveHardFailures = 0;

    console.log('[MANGA CACHE] Refresh started (Jikan).');

    try {
        for (let page = 1; page <= TOTAL_PAGES; page++) {
            const result = await fetchPage(page);

            if (result.ok) {
                pagesLoaded++;
                consecutiveHardFailures = 0;
                tempCache.push(...result.items);
            } else {
                if (result.status === 429) {
                    rateLimitedPages++;
                } else if (result.status >= 500) {
                    serverErrorPages++;
                } else if (result.status === 0) {
                    networkErrorPages++;
                } else {
                    otherErrorPages++;
                }

                if (result.status === 0 || result.status >= 500) {
                    consecutiveHardFailures++;
                    if (consecutiveHardFailures >= MAX_CONSECUTIVE_HARD_FAILURES && tempCache.length < 10) {
                        break;
                    }
                }
            }

            await sleep(DELAY_BETWEEN_REQUESTS);
        }

        const durationMs = Date.now() - startedAt;
        const stats = `pages_ok=${pagesLoaded}/${TOTAL_PAGES}, items=${tempCache.length}, 429=${rateLimitedPages}, 5xx=${serverErrorPages}, net=${networkErrorPages}, other=${otherErrorPages}, ms=${durationMs}`;

        if (tempCache.length >= MIN_READY_ITEMS) {
            mangaCache = tempCache;
            isInitialized = true;

            if (retryTimeout) {
                clearTimeout(retryTimeout);
                retryTimeout = null;
            }

            console.log(`[MANGA CACHE] Refresh complete. ${stats}`);
        } else {
            if (isInitialized && mangaCache.length >= MIN_READY_ITEMS) {
                console.warn(`[MANGA CACHE] Refresh incomplete; keeping previous cache (${mangaCache.length} items). ${stats}`);
            } else {
                console.warn(`[MANGA CACHE] Cache not ready yet. ${stats}`);
            }
            scheduleRetry();
        }
    } catch (globalErr) {
        console.error('[MANGA CACHE] Fatal refresh error:', globalErr);
        scheduleRetry();
    } finally {
        isInitializing = false;
    }
}

function getMangaPair(currentManga = null) {
    if (!isInitialized || mangaCache.length < 10) {
        return null;
    }

    // New game: pick 2 random distinct entries.
    if (!currentManga) {
        let idx1 = Math.floor(Math.random() * mangaCache.length);
        let idx2 = Math.floor(Math.random() * mangaCache.length);

        while (idx1 === idx2) {
            idx2 = Math.floor(Math.random() * mangaCache.length);
        }
        return [mangaCache[idx1], mangaCache[idx2]];
    }

    // Continue game: keep winner, pick new challenger.
    let nextIdx = Math.floor(Math.random() * mangaCache.length);
    let nextManga = mangaCache[nextIdx];
    let attempts = 0;

    while (nextManga.id === currentManga.id && attempts < 10) {
        nextIdx = Math.floor(Math.random() * mangaCache.length);
        nextManga = mangaCache[nextIdx];
        attempts++;
    }

    return [currentManga, nextManga];
}

function init() {
    // Run immediately (non-blocking)
    fetchTopManga();

    // Refresh every 24 hours
    setInterval(fetchTopManga, 24 * 60 * 60 * 1000);
}

function isReady() {
    return isInitialized && mangaCache.length > 10;
}

module.exports = {
    init,
    getMangaPair,
    isReady
};
