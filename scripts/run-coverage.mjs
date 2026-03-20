#!/usr/bin/env node
/**
 * Runs both coverage suites and prints a combined summary with pass/fail status.
 * Exits with code 1 if any suite failed.
 */

import { spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";

// ── Run coverage suites ───────────────────────────────────────────────────────

const suites = [
    { label: "API",       cmd: "pnpm", args: ["run", "api:coverage"],  lcov: "coverage/api/lcov.info" },
    { label: "Extension", cmd: "pnpm", args: ["run", "ext:coverage"],  lcov: "coverage/extension/lcov.info" },
];

for (const suite of suites) {
    const result = spawnSync(suite.cmd, suite.args, { stdio: "inherit", shell: true });
    suite.passed = result.status === 0;
}

// ── Parse lcov ────────────────────────────────────────────────────────────────

function parseLcov(path) {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    let lf = 0, lh = 0, fnf = 0, fnh = 0, brf = 0, brh = 0;
    for (const line of text.split("\n")) {
        if (line.startsWith("LF:"))  lf  += parseInt(line.slice(3));
        if (line.startsWith("LH:"))  lh  += parseInt(line.slice(3));
        if (line.startsWith("FNF:")) fnf += parseInt(line.slice(4));
        if (line.startsWith("FNH:")) fnh += parseInt(line.slice(4));
        if (line.startsWith("BRF:")) brf += parseInt(line.slice(4));
        if (line.startsWith("BRH:")) brh += parseInt(line.slice(4));
    }
    return { lf, lh, fnf, fnh, brf, brh };
}

function pct(hit, total) {
    if (total === 0) return "N/A";
    return ((hit / total) * 100).toFixed(1) + "%";
}

function cell(hit, total) {
    return `${pct(hit, total)} (${hit}/${total})`;
}

// ── Build table ───────────────────────────────────────────────────────────────

const totals = { lf: 0, lh: 0, fnf: 0, fnh: 0, brf: 0, brh: 0 };
const rows = [];

for (const suite of suites) {
    const r = parseLcov(suite.lcov);
    const status = suite.passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    if (!r) { rows.push({ label: suite.label, status, missing: true }); continue; }
    for (const k of Object.keys(totals)) totals[k] += r[k];
    rows.push({ label: suite.label, status, ...r });
}

const headers = ["Suite", "Status", "Lines", "Functions", "Branches"];
const dataRows = [
    ...rows.map(r => r.missing
        ? [r.label, r.status, "(no report)", "", ""]
        : [r.label, r.status, cell(r.lh, r.lf), cell(r.fnh, r.fnf), cell(r.brh, r.brf)]
    ),
    ["Total", "", cell(totals.lh, totals.lf), cell(totals.fnh, totals.fnf), cell(totals.brh, totals.brf)],
];

// Strip ANSI codes for width calculation
const visibleLen = s => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const widths = headers.map((h, i) =>
    Math.max(h.length, ...dataRows.map(r => visibleLen(r[i] ?? "")))
);

const pad = (s, w) => {
    const visible = visibleLen(s);
    return s + " ".repeat(Math.max(0, w - visible));
};

const SEP = "─".repeat(widths.reduce((a, w) => a + w + 3, 1));

const fmtRow = (cols, bold = false) => {
    const line = "  " + cols.map((c, i) => pad(c, widths[i])).join("   ");
    return bold ? `\x1b[1m${line}\x1b[0m` : line;
};

console.log("\n\x1b[1m Coverage Summary \x1b[0m");
console.log(SEP);
console.log(fmtRow(headers));
console.log(SEP);
for (let i = 0; i < dataRows.length - 1; i++) console.log(fmtRow(dataRows[i]));
console.log(SEP);
console.log(fmtRow(dataRows[dataRows.length - 1], true));
console.log(SEP + "\n");

const failed = suites.filter(s => !s.passed);
process.exit(failed.length > 0 ? 1 : 0);
