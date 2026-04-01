/**
 * generate-pages.ts
 * Reads ROADMAP.md and bloom.db, then writes docs/index.html and
 * docs/journal.html for GitHub Pages.
 *
 * Usage:  tsx scripts/generate-pages.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { initDb, getCycleStats, exportJournalJson } from "../src/db.js";
import {
  parseRoadmapSections,
  renderStatsSection,
  renderJournalSection,
  generateHtml,
  generateJournalHtml,
  generateStatsHtml,
} from "../src/page-helpers.js";
import type { DbStats } from "../src/page-helpers.js";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const roadmapPath = resolve(repoRoot, "ROADMAP.md");
if (!existsSync(roadmapPath)) {
  console.error(`[generate-pages] ROADMAP.md not found at ${roadmapPath}`);
  process.exit(1);
}

const content = readFileSync(roadmapPath, "utf-8");
const sections = parseRoadmapSections(content);
const generatedAt = new Date().toUTCString();

// Ensure docs/ directory exists early so both files can be written
const docsDir = resolve(repoRoot, "docs");
if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });

// Load SQLite data if the database exists
let statsSection = "";
let journalSection = "";
let dbStats: DbStats | null = null;

const dbPath = resolve(repoRoot, "bloom.db");
if (existsSync(dbPath)) {
  try {
    const db = initDb(dbPath);
    const stats = getCycleStats(db, 20);
    if (stats.totalCycles > 0) {
      dbStats = stats;
      statsSection = renderStatsSection(stats);
    }
    const journalEntries = exportJournalJson(db, 5);
    const allJournalEntries = exportJournalJson(db, 100);
    if (journalEntries.length > 0) {
      journalSection = renderJournalSection(journalEntries);
    }
    console.log(`[generate-pages] Loaded ${stats.totalCycles} cycles and ${allJournalEntries.length} journal entries from bloom.db`);

    // Write docs/journal.html with full history
    const journalHtml = generateJournalHtml(allJournalEntries, generatedAt);
    const journalOutPath = resolve(docsDir, "journal.html");
    writeFileSync(journalOutPath, journalHtml, "utf-8");
    console.log(`[generate-pages] Wrote ${journalOutPath}`);
  } catch (err) {
    console.warn(`[generate-pages] Could not read bloom.db: ${err}`);
  }
} else {
  console.log("[generate-pages] bloom.db not found — skipping stats and journal sections");
}

// Write docs/stats.html with full metrics table
const statsHtml = generateStatsHtml(dbStats, generatedAt);
const statsOutPath = resolve(docsDir, "stats.html");
writeFileSync(statsOutPath, statsHtml, "utf-8");
console.log(`[generate-pages] Wrote ${statsOutPath}`);

const html = generateHtml(sections, generatedAt, statsSection, journalSection);

const outPath = resolve(docsDir, "index.html");
writeFileSync(outPath, html, "utf-8");

console.log(`[generate-pages] Wrote ${outPath}`);
