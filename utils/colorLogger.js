'use strict';

const util = require('util');

// ANSI Escape Codes
const c = {
    green:   '\x1b[32m',
    cyan:    '\x1b[36m',
    yellow:  '\x1b[33m',
    red:     '\x1b[31m',
    magenta: '\x1b[35m',
    reset:   '\x1b[0m'
};

// Store original console methods to prevent infinite loops
const origLog   = console.log;
const origWarn  = console.warn;
const origError = console.error;
const origInfo  = console.info;

// If we are not in an interactive terminal (e.g. piped to a file or running in PM2 without TTY),
// we don't want to pollute the text file with ANSI color codes.
// process.stdout.isTTY is true only when running directly in a console.
if (process.stdout.isTTY) {

    /**
     * Master formatting function.
     * 1. Uses native util.formatWithOptions to perfectly preserve object highlighting and %s substitutions.
     * 2. Detects [PREFIX] tags and colors them Magenta.
     * 3. Wraps the remaining string in the specified base color (Red/Yellow/Green).
     */
    const colorize = (args, baseColor) => {
        // Native string formatting with object inspection
        const formatted = util.formatWithOptions({ colors: true }, ...args);

        // Replace things like [ROLE_SYNC] or [AutoUpdate] with magenta
        const withPrefixColors = formatted.replace(/^(\[[^\]]+\])/, `${c.magenta}$1${c.reset}${baseColor}`);

        return `${baseColor}${withPrefixColors}${c.reset}`;
    };

    // Override globals
    console.log = function(...args) {
        origLog(colorize(args, c.green));
    };

    console.info = function(...args) {
        origInfo(colorize(args, c.cyan));
    };

    console.warn = function(...args) {
        origWarn(colorize(args, c.yellow));
    };

    console.error = function(...args) {
        origError(colorize(args, c.red));
    };
}
