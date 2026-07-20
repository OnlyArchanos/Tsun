const { setTimeout: sleep } = require('timers/promises');

let mangaCache = [];
let isInitialized = false;
let isInitializing = false;
let retryTimeout = null;

// AniList API settings.
const DELAY_BETWEEN_REQUESTS = 1000;
const TOTAL_PAGES = 16;
const REQUEST_TIMEOUT_MS = 10000;
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
    while (true) {
        try {
            const query = `
                query {
                    Page(page: ${page}, perPage: 50) {
                        media(type: MANGA, sort: POPULARITY_DESC, isAdult: false) {
                            id
                            title {
                                romaji
                                english
                            }
                            coverImage {
                                large
                            }
                            averageScore
                            popularity
                        }
                    }
                }
            `;

            const response = await fetch(`https://graphql.anilist.co`, {
                method: 'POST',
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': 'TsunBot/1.0' 
                },
                body: JSON.stringify({ query })
            });

            if (!response.ok) {
                if (response.status === 429) {
                    const retryAfter = response.headers.get('retry-after') || 10;
                    await sleep(retryAfter * 1000);
                    continue;
                }
                return { ok: false, status: response.status };
            }

            const data = await response.json();
            const list = data?.data?.Page?.media;
            
            if (!Array.isArray(list)) {
                 return { ok: false, status: 500, error: 'Invalid AniList format' };
            }

            const cleanData = list
                .filter(m =>
                    m.averageScore !== null &&
                    m.averageScore !== undefined &&
                    !isNaN(m.averageScore) &&
                    m.coverImage?.large &&
                    (m.title?.romaji || m.title?.english)
                )
                .map((m, idx) => ({
                    id: m.id,
                    title: m.title.english || m.title.romaji,
                    score: parseFloat((m.averageScore / 10).toFixed(2)), // Convert 100-point to 10-point
                    image: m.coverImage.large,
                    rank: ((page - 1) * 50) + idx + 1, // AniList doesn't return global rank for popularity sorts natively, so we approximate
                    popularity: m.popularity
                }));

            return { ok: true, items: cleanData };
        } catch (err) {
            return { ok: false, status: 0, error: err?.message || 'unknown error' };
        }
    }
}

/**
 * Fetches top manga from AniList API.
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

    console.log('[MANGA CACHE] Refresh started (AniList).');

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
