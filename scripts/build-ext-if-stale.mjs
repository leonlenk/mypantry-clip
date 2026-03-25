#!/usr/bin/env node
/**
 * Rebuilds the extension only when source files are newer than dist/.
 * Watches: apps/extension/src/, apps/extension/astro.config.*, apps/extension/package.json
 */

import { execSync } from "child_process";
import { existsSync, statSync, readdirSync } from "fs";
import { join } from "path";

const DIST_SENTINEL = "apps/extension/dist/manifest.json";
const WATCH_DIRS = ["apps/extension/src"];
const WATCH_FILES = [
    "apps/extension/astro.config.ts",
    "apps/extension/astro.config.mjs",
    "apps/extension/package.json",
];

function newestMtime(dir) {
    let newest = 0;
    function walk(d) {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const full = join(d, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else {
                const mt = statSync(full).mtimeMs;
                if (mt > newest) newest = mt;
            }
        }
    }
    walk(dir);
    return newest;
}

if (!existsSync(DIST_SENTINEL)) {
    console.log("dist/ not found — building extension...");
    execSync("pnpm run build", { stdio: "inherit" });
    process.exit(0);
}

const distMtime = statSync(DIST_SENTINEL).mtimeMs;

let srcNewest = 0;
for (const dir of WATCH_DIRS) {
    const mt = newestMtime(dir);
    if (mt > srcNewest) srcNewest = mt;
}
for (const file of WATCH_FILES) {
    if (existsSync(file)) {
        const mt = statSync(file).mtimeMs;
        if (mt > srcNewest) srcNewest = mt;
    }
}

if (srcNewest > distMtime) {
    console.log("Extension sources changed — rebuilding...");
    execSync("pnpm run build", { stdio: "inherit" });
} else {
    console.log("Extension is up to date, skipping build.");
}
