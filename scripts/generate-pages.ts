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
  renderSection,
  renderStatsSection,
  renderJournalSection,
  renderJournalCards,
  escapeHtml,
} from "../src/page-helpers.js";

// ---------------------------------------------------------------------------
// Full HTML pages
// ---------------------------------------------------------------------------

function generateHtml(
  sections: ReturnType<typeof parseRoadmapSections>,
  generatedAt: string,
  statsSection: string,
  journalSection: string,
): string {
  const sectionsHtml = sections.map(renderSection).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bloom Evolution Roadmap</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f9fafb;
      color: #111827;
      padding: 2rem 1rem;
      max-width: 760px;
      margin: 0 auto;
    }
    header { margin-bottom: 2rem; }
    header h1 { font-size: 1.75rem; font-weight: 700; }
    header p { color: #6b7280; margin-top: 0.25rem; font-size: 0.9rem; }
    .section { margin-bottom: 2rem; }
    .section h2 { margin-bottom: 0.75rem; }
    .badge {
      display: inline-block;
      color: #fff;
      font-size: 0.85rem;
      font-weight: 600;
      padding: 0.2rem 0.65rem;
      border-radius: 999px;
    }
    ul { list-style: none; display: flex; flex-direction: column; gap: 0.5rem; }
    .item {
      display: flex;
      align-items: flex-start;
      gap: 0.6rem;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 0.5rem;
      padding: 0.6rem 0.9rem;
    }
    .item.done { opacity: 0.6; }
    .check { font-size: 1rem; flex-shrink: 0; line-height: 1.5; }
    .item-body { flex: 1; min-width: 0; }
    .item-title { font-weight: 500; word-break: break-word; }
    .item-title .issue-link { color: #2563eb; text-decoration: none; font-size: 0.85rem; margin-left: 0.3rem; }
    .item-title .issue-link:hover { text-decoration: underline; }
    .item-desc { color: #6b7280; font-size: 0.85rem; margin-top: 0.25rem; }
    /* Stats table */
    .stats-note { color: #6b7280; font-size: 0.85rem; margin-bottom: 0.75rem; }
    .stats-table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e7eb; border-radius: 0.5rem; overflow: hidden; }
    .stats-table td { padding: 0.5rem 0.9rem; font-size: 0.9rem; border-bottom: 1px solid #f3f4f6; }
    .stats-table tr:last-child td { border-bottom: none; }
    .stats-table td:first-child { color: #6b7280; width: 60%; }
    /* Journal */
    .journal-card {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 0.5rem;
      margin-bottom: 0.5rem;
      overflow: hidden;
    }
    .journal-card summary {
      cursor: pointer;
      padding: 0.6rem 0.9rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      user-select: none;
    }
    .journal-card summary:hover { background: #f9fafb; }
    .cycle-badge {
      background: #0891b2;
      color: #fff;
      font-size: 0.8rem;
      font-weight: 600;
      padding: 0.15rem 0.55rem;
      border-radius: 999px;
    }
    .cycle-date { color: #6b7280; font-size: 0.85rem; }
    .journal-body { padding: 0.75rem 0.9rem; border-top: 1px solid #f3f4f6; display: flex; flex-direction: column; gap: 0.6rem; }
    .journal-field p { font-size: 0.85rem; color: #374151; margin-top: 0.2rem; white-space: pre-wrap; word-break: break-word; }
    .journal-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
    .succeeded-label { color: #16a34a; }
    .failed-label { color: #dc2626; }
    footer { color: #9ca3af; font-size: 0.8rem; text-align: center; margin-top: 3rem; }
  </style>
</head>
<body>
  <header>
    <h1>🌸 Bloom Evolution Roadmap</h1>
    <p>Last updated: ${escapeHtml(generatedAt)}</p>
  </header>
  ${sectionsHtml}
  ${statsSection}
  ${journalSection}
  <footer>Generated from <code>ROADMAP.md</code> + <code>bloom.db</code> · <a href="https://github.com/anthropics/bloom" style="color:#9ca3af">github.com/anthropics/bloom</a></footer>
</body>
</html>
`;
}

function generateJournalHtml(
  entries: Parameters<typeof renderJournalCards>[0],
  generatedAt: string,
): string {
  const cards = entries.length > 0 ? renderJournalCards(entries) : "<p>No journal entries yet.</p>";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bloom Full Journal</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f9fafb;
      color: #111827;
      padding: 2rem 1rem;
      max-width: 760px;
      margin: 0 auto;
    }
    header { margin-bottom: 2rem; }
    header h1 { font-size: 1.75rem; font-weight: 700; }
    header p { color: #6b7280; margin-top: 0.25rem; font-size: 0.9rem; }
    .back-link { display: inline-block; margin-bottom: 1.5rem; color: #2563eb; text-decoration: none; font-size: 0.9rem; }
    .back-link:hover { text-decoration: underline; }
    .badge {
      display: inline-block;
      color: #fff;
      font-size: 0.85rem;
      font-weight: 600;
      padding: 0.2rem 0.65rem;
      border-radius: 999px;
    }
    .stats-note { color: #6b7280; font-size: 0.85rem; margin-bottom: 0.75rem; }
    .journal-card {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 0.5rem;
      margin-bottom: 0.5rem;
      overflow: hidden;
    }
    .journal-card summary {
      cursor: pointer;
      padding: 0.6rem 0.9rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      user-select: none;
    }
    .journal-card summary:hover { background: #f9fafb; }
    .cycle-badge {
      background: #0891b2;
      color: #fff;
      font-size: 0.8rem;
      font-weight: 600;
      padding: 0.15rem 0.55rem;
      border-radius: 999px;
    }
    .cycle-date { color: #6b7280; font-size: 0.85rem; }
    .journal-body { padding: 0.75rem 0.9rem; border-top: 1px solid #f3f4f6; display: flex; flex-direction: column; gap: 0.6rem; }
    .journal-field p { font-size: 0.85rem; color: #374151; margin-top: 0.2rem; white-space: pre-wrap; word-break: break-word; }
    .journal-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
    .succeeded-label { color: #16a34a; }
    .failed-label { color: #dc2626; }
    footer { color: #9ca3af; font-size: 0.8rem; text-align: center; margin-top: 3rem; }
  </style>
</head>
<body>
  <a class="back-link" href="index.html">← Roadmap</a>
  <header>
    <h1>📓 Bloom Full Journal</h1>
    <p>Last updated: ${escapeHtml(generatedAt)}</p>
  </header>
  <section>
    <p class="stats-note">All recorded evolution cycle summaries.</p>
    ${cards}
  </section>
  <footer>Generated from <code>bloom.db</code> · <a href="https://github.com/anthropics/bloom" style="color:#9ca3af">github.com/anthropics/bloom</a></footer>
</body>
</html>
`;
}

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

const dbPath = resolve(repoRoot, "bloom.db");
if (existsSync(dbPath)) {
  try {
    const db = initDb(dbPath);
    const stats = getCycleStats(db, 20);
    if (stats.totalCycles > 0) {
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

const html = generateHtml(sections, generatedAt, statsSection, journalSection);

const outPath = resolve(docsDir, "index.html");
writeFileSync(outPath, html, "utf-8");

console.log(`[generate-pages] Wrote ${outPath}`);
