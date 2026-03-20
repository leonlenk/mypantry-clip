#!/usr/bin/env node
// Parses both lcov files and prints a combined coverage summary.
import { readFileSync, existsSync } from "fs";

const LCOV_FILES = {
    "Extension": "coverage/extension/lcov.info",
    "API":       "coverage/api/lcov.info",
};

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

const totals = { lf: 0, lh: 0, fnf: 0, fnh: 0, brf: 0, brh: 0 };
const rows = [];

for (const [label, file] of Object.entries(LCOV_FILES)) {
    const r = parseLcov(file);
    if (!r) { rows.push({ label, missing: true }); continue; }
    for (const k of Object.keys(totals)) totals[k] += r[k];
    rows.push({ label, ...r });
}

// Compute column widths dynamically
const headers = ["Suite", "Lines", "Functions", "Branches"];
const dataRows = [
    ...rows.map(r => r.missing
        ? [r.label, "(no report)", "", ""]
        : [r.label, cell(r.lh, r.lf), cell(r.fnh, r.fnf), cell(r.brh, r.brf)]
    ),
    ["Total",
        cell(totals.lh, totals.lf),
        cell(totals.fnh, totals.fnf),
        cell(totals.brh, totals.brf),
    ],
];

const widths = headers.map((h, i) =>
    Math.max(h.length, ...dataRows.map(r => (r[i] ?? "").length))
);

const pad = (s, w) => String(s).padEnd(w);
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
