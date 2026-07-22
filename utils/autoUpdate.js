'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// --- Constants ----------------------------------------------------------------

const REPO              = 'OnlyArchanos/Tsun';
const BRANCH            = 'main';
const ROOT              = path.join(__dirname, '..');
const STATE_FILE        = path.join(ROOT, '.update_state.json');
const GITHUB_API        = 'https://api.github.com';
const GITHUB_RAW        = 'https://raw.githubusercontent.com';
const DOWNLOAD_CONCURRENCY = 5;
const API_TIMEOUT       = 10000;
const DOWNLOAD_TIMEOUT  = 20000;
const NPM_TIMEOUT       = 120000;
const LOG               = '[AutoUpdate]';

// --- Protected path check -----------------------------------------------------

function isProtected(filePath) {
    const name = path.basename(filePath);
    if (name === '.env') return true;
    if (name.startsWith('.env.') && name !== '.env.example') return true;
    if (filePath === 'node_modules' || filePath.startsWith('node_modules/')) return true;
    if (filePath === 'web/node_modules' || filePath.startsWith('web/node_modules/')) return true;
    if (filePath === '.update_state.json') return true;
    if (filePath === 'launcher.js') return true;
    return false;
}

// --- Path safety check --------------------------------------------------------

function isSafePath(filePath) {
    return !filePath.split('/').some(seg => seg === '..' || seg === '');
}

// --- State management ---------------------------------------------------------

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return { commitSha: null, files: {} };
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        if (!raw.trim()) {
            console.warn(`${LOG} State file is empty. Treating as first run.`);
            return { commitSha: null, files: {} };
        }
        const parsed = JSON.parse(raw);
        return {
            commitSha: typeof parsed.commitSha === 'string' ? parsed.commitSha : null,
            files:     (parsed.files && typeof parsed.files === 'object') ? parsed.files : {}
        };
    } catch (e) {
        console.warn(`${LOG} State file unreadable (${e.message}). Treating as first run.`);
        return { commitSha: null, files: {} };
    }
}

function saveState(state) {
    try {
        const tmpPath = STATE_FILE + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
        fs.renameSync(tmpPath, STATE_FILE);
    } catch (e) {
        console.warn(`${LOG} Failed to save state (${e.message}). Next startup will re-check all files.`);
    }
}

// --- Blob SHA verification ----------------------------------------------------

function verifyBlobSha(content, expectedSha) {
    const hash = crypto.createHash('sha1');
    hash.update(`blob ${content.length}\0`);
    hash.update(content);
    return hash.digest('hex') === expectedSha;
}

// --- Atomic file write --------------------------------------------------------

function atomicWrite(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = filePath + '.update_tmp';
    try {
        fs.writeFileSync(tmpPath, content);
        fs.renameSync(tmpPath, filePath);
    } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        throw e;
    }
}

// --- GitHub API helpers -------------------------------------------------------

async function getLatestCommitSha() {
    const res = await axios.get(`${GITHUB_API}/repos/${REPO}/commits/${BRANCH}`, {
        headers: { 'User-Agent': 'TsunBot-AutoUpdater/1.0', 'Accept': 'application/vnd.github.v3+json' },
        timeout: API_TIMEOUT
    });
    if (!res.data || typeof res.data.sha !== 'string') {
        throw new Error('Unexpected response shape from GitHub commits API');
    }
    return res.data.sha;
}

async function getFileTree(commitSha) {
    const res = await axios.get(
        `${GITHUB_API}/repos/${REPO}/git/trees/${commitSha}?recursive=1`,
        {
            headers: { 'User-Agent': 'TsunBot-AutoUpdater/1.0', 'Accept': 'application/vnd.github.v3+json' },
            timeout: API_TIMEOUT
        }
    );
    if (!res.data || !Array.isArray(res.data.tree)) {
        throw new Error('Unexpected response shape from GitHub tree API');
    }
    if (res.data.truncated === true) {
        throw new Error('GitHub tree response was truncated. Update aborted safely.');
    }
    return res.data.tree.filter(item => item.type === 'blob');
}

async function downloadFile(filePath, commitSha) {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const url = `${GITHUB_RAW}/${REPO}/${commitSha}/${encodedPath}`;
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: DOWNLOAD_TIMEOUT });
    return Buffer.from(res.data);
}

// --- Concurrency-limited batch runner -----------------------------------------

async function runBatch(items, fn, concurrency = DOWNLOAD_CONCURRENCY) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(batch.map(fn));
        results.push(...batchResults);
    }
    return results;
}

// --- npm install helper -------------------------------------------------------

function runNpmInstall(cwd) {
    try {
        console.log(`${LOG} Running npm install in ${path.relative(ROOT, cwd) || '.'}...`);
        execSync('npm install --no-audit --no-fund', {
            cwd, stdio: 'inherit', shell: true, timeout: NPM_TIMEOUT
        });
        console.log(`${LOG} npm install complete.`);
    } catch (e) {
        console.error(`${LOG} npm install failed: ${e.message}. Existing packages will be used.`);
    }
}

// --- Main export --------------------------------------------------------------

async function autoUpdate() {
    console.log(`${LOG} Checking for updates...`);

    const state = loadState();

    // Fetch latest commit SHA — network failure here is non-fatal
    let latestSha;
    try {
        latestSha = await getLatestCommitSha();
    } catch (e) {
        console.warn(`${LOG} Cannot reach GitHub (${e.message}). Skipping update check.`);
        return false;
    }

    if (state.commitSha === latestSha) {
        console.log(`${LOG} Already up to date (${latestSha.slice(0, 7)}).`);
        return false;
    }

    const isFirstRun = state.commitSha === null;
    if (isFirstRun) {
        console.log(`${LOG} First run — syncing to latest commit (${latestSha.slice(0, 7)})...`);
    } else {
        console.log(`${LOG} Update available: ${state.commitSha.slice(0, 7)} ? ${latestSha.slice(0, 7)}`);
    }

    // Fetch file tree — failure here is also non-fatal
    let tree;
    try {
        tree = await getFileTree(latestSha);
    } catch (e) {
        console.error(`${LOG} Failed to fetch file tree: ${e.message}. Update aborted.`);
        return false;
    }

    const newTreeMap = Object.fromEntries(tree.map(item => [item.path, item.sha]));

    // Classify: which files to download, which to delete
    const toDownload = [];
    for (const item of tree) {
        if (!isSafePath(item.path)) { console.warn(`${LOG} Skipping unsafe path: "${item.path}"`); continue; }
        if (isProtected(item.path)) continue;
        if (state.files[item.path] !== item.sha) toDownload.push(item);
    }

    const toDelete = isFirstRun
        ? []
        : Object.keys(state.files).filter(p => !newTreeMap[p] && !isProtected(p) && isSafePath(p));

    if (toDownload.length === 0 && toDelete.length === 0) {
        state.commitSha = latestSha;
        saveState(state);
        console.log(`${LOG} Commit advanced but no tracked file changes. State updated.`);
        return false;
    }

    console.log(`${LOG} ${toDownload.length} file(s) to update, ${toDelete.length} file(s) to remove.`);

    const needsRootNpmInstall = toDownload.some(f => f.path === 'package.json');
    const needsWebNpmInstall  = toDownload.some(f => f.path === 'web/package.json');

    // Download files with concurrency limit
    let successCount = 0;
    const downloadResults = await runBatch(toDownload, async (item) => {
        let content;
        try {
            content = await downloadFile(item.path, latestSha);
        } catch (e) {
            throw new Error(`Download failed: ${e.message}`);
        }

        if (!verifyBlobSha(content, item.sha)) {
            throw new Error('Blob SHA mismatch — corrupt or unexpected content');
        }

        const targetPath = path.join(ROOT, ...item.path.split('/'));
        try {
            atomicWrite(targetPath, content);
        } catch (e) {
            throw new Error(`Write failed: ${e.message}`);
        }

        // Update state only after confirmed successful write
        state.files[item.path] = item.sha;
        successCount++;
        return item.path;
    });

    for (let i = 0; i < downloadResults.length; i++) {
        const r = downloadResults[i];
        if (r.status === 'fulfilled') {
            console.log(`${LOG}   ? ${r.value}`);
        } else {
            console.warn(`${LOG}   ? ${toDownload[i].path} — ${r.reason?.message ?? 'unknown error'}`);
        }
    }

    // Delete files removed from the repo
    for (const filePath of toDelete) {
        const targetPath = path.join(ROOT, ...filePath.split('/'));
        try {
            if (fs.existsSync(targetPath)) {
                fs.unlinkSync(targetPath);
                console.log(`${LOG}   ??  ${filePath}`);
            }
            delete state.files[filePath];
        } catch (e) {
            console.warn(`${LOG}   Could not delete ${filePath}: ${e.message}`);
        }
    }

    // Save state before npm install (so a crash in npm install doesn't lose update progress)
    state.commitSha = latestSha;
    saveState(state);

    console.log(`${LOG} Done. ${successCount}/${toDownload.length} file(s) updated.`);

    if (needsRootNpmInstall) runNpmInstall(ROOT);
    if (needsWebNpmInstall)  runNpmInstall(path.join(ROOT, 'web'));

    return successCount > 0;
}

module.exports = autoUpdate;
