require('./utils/colorLogger');
'use strict';

console.log(`\x1b[35m
  _______  _____  _    _  _   _ 
 |__   __|/ ____|| |  | || \\ | |
    | |  | (___  | |  | ||  \\| |
    | |   \\___ \\ | |  | || . \` |
    | |   ____) || |__| || |\\  |
    |_|  |_____/  \\____/ |_| \\_|
                                 
      Tsundere Bot Launcher
\x1b[0m`);

// launcher.js — bootstrapper that runs the auto-updater before starting the bot.
// Change package.json "start" to "node launcher.js" and this runs instead of node index.js directly.
//
// Boot sequence:
//   1. Load .env  (must happen before autoUpdate so env vars are available)
//   2. Run auto-updater (downloads any changed files from GitHub)
//   3. require('./index.js')  — loads the bot with whatever is now on disk (updated code)
//
// IMPORTANT: require('./index.js') is inside a try/finally so the bot ALWAYS starts,
// even if the update step throws an unexpected error.

require('dotenv').config();
const autoUpdate = require('./utils/autoUpdate');

(async () => {
    try {
        await autoUpdate();
    } catch (e) {
        // autoUpdate() is designed to never throw, but this is an extra safety net.
        console.error('[Launcher] Unexpected error in auto-updater:', e.message);
        console.error('[Launcher] Continuing with existing files...');
    }

    // Always start the bot — index.js is loaded AFTER the update so it uses fresh files.
    require('./index.js');
})();

