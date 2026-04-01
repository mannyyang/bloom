/**
 * generate-pages.ts
 * Reads ROADMAP.md and bloom.db, then writes docs/index.html for GitHub Pages.
 *
 * Usage:  tsx scripts/generate-pages.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { initDb, getCycleStats, exportJournalJson } from "../src/db.js";

// ---------------------------------------------------------------------------
// Minimal types (inlined to avoid extra src/ imports in a script)
// ---------------------------------------------------------------------------

interface RoadmapSection {
  heading: string;
  items: RoadmapItem[];
}

interface RoadmapItem {
  done: boolean;
  title: string;
  issueNumber: number | null;
  description: string;
}

// ---------------------------------------------------------------------------
// Parse ROADMAP.md
// ---------------------------------------------------------------------------

function parseRoadmapSections(content: string): RoadmapSection[] {
  const sections: RoadmapSection[] = [];
  let currentSection: RoadmapSection | null = null;
  let currentItem: RoadmapItem | null = null;

  const flush = () => {
    if (currentItem && currentSection) {
      currentSection.items.push(currentItem);
      currentItem = null;
    }
  };

  for (const rawLine of content.split("\n")) {
    const line = rawLine;

    // ## Section heading
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      flush();
      if (currentSection) sections.push(currentSection);
      currentSection = { heading: headingMatch[1].trim(), items: [] };
      continue;
    }

    // - [ ] or - [x] item line
    const itemMatch = line.match(/^- \[([ x])\] (.+)$/);
    if (itemMatch && currentSection) {
      flush();
      const done = itemMatch[1] === "x";
      const rest = itemMatch[2];
      const issueMatch = rest.match(/\(#(\d+)\)\s*$/);
      const issueNumber = issueMatch ? parseInt(issueMatch[1], 10) : null;
      const title = rest.replace(/\s*\(#\d+\)\s*$/, "").trim();
      currentItem = { done, title, issueNumber, description: "" };
      continue;
    }

    // [since: N] line — skip
    if (line.match(/^\s+\[since:\s*\d+\]$/)) continue;

    // Indented description line
    if (line.match(/^\s{2,}/) && currentItem) {
      const desc = line.trim();
      if (desc) {
        currentItem.description = currentItem.description
          ? `${currentItem.description} ${desc}`
          : desc;
      }
      continue;
    }
  }

  flush();
  if (currentSection) sections.push(currentSection);
  return sections;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  Backlog: "#6b7280",
  "Up Next": "#2563eb",
  "In Progress": "#d97706",
  Done: "#16a34a",
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSection(section: RoadmapSection): string {
  if (section.items.length === 0) return "";

  const color = STATUS_COLORS[section.heading] ?? "#374151";
  const badge = `<span class="badge" style="background:${color}">${escapeHtml(section.heading)}</span>`;

  const itemsHtml = section.items
    .map((item) => {
      const doneClass = item.done ? " done" : "";
      const check = item.done ? "✅" : "⬜";
      const issueLink = item.issueNumber
        ? ` <a class="issue-link" href="https://github.com/anthropics/bloom/issues/${item.issueNumber}" target="_blank" rel="noopener">#${item.issueNumber}</a>`
        : "";
      const desc = item.description
        ? `<p class="item-desc">${escapeHtml(item.description)}</p>`
        : "";
      return `
      <li class="item${doneClass}">
        <span class="check">${check}</span>
        <div class="item-body">
          <span class="item-title">${escapeHtml(item.title)}${issueLink}</span>
          ${desc}
        </div>
      </li>`;
    })
    .join("");

  return `
  <section class="section">
    <h2>${badge}</h2>
    <ul>${itemsHtml}</ul>
  </section>`;
}

// ---------------------------------------------------------------------------
// Cycle stats section (from SQLite)
// ---------------------------------------------------------------------------

interface DbStats {
  totalCycles: number;
  successRate: number;
  avgImprovements: number;
  avgConversionRate: number | null;
  recentFailures: number;
  avgDurationMinutes: number | null;
  totalCostUsd: number;
}

function renderStatsSection(stats: DbStats): string {
  const rows: string[] = [
    `<tr><td>Total cycles</td><td><strong>${stats.totalCycles}</strong></td></tr>`,
    `<tr><td>Success rate</td><td><strong>${stats.successRate}%</strong></td></tr>`,
    `<tr><td>Avg improvements / cycle</td><td><strong>${stats.avgImprovements}</strong></td></tr>`,
  ];
  if (stats.avgConversionRate !== null) {
    rows.push(`<tr><td>Improvement conversion rate</td><td><strong>${stats.avgConversionRate}%</strong></td></tr>`);
  }
  if (stats.avgDurationMinutes !== null) {
    rows.push(`<tr><td>Avg cycle duration</td><td><strong>${stats.avgDurationMinutes} min</strong></td></tr>`);
  }
  if (stats.totalCostUsd > 0) {
    rows.push(`<tr><td>Total cost (last 20 cycles)</td><td><strong>$${stats.totalCostUsd.toFixed(2)}</strong></td></tr>`);
  }
  rows.push(`<tr><td>Recent failures (last 5 cycles)</td><td><strong>${stats.recentFailures}</strong></td></tr>`);

  return `
  <section class="section">
    <h2><span class="badge" style="background:#7c3aed">📊 Cycle Stats</span></h2>
    <p class="stats-note">Live metrics from the last 20 evolution cycles.</p>
    <table class="stats-table">
      <tbody>
        ${rows.join("\n        ")}
      </tbody>
    </table>
  </section>`;
}

// ---------------------------------------------------------------------------
// Recent journal section (from SQLite)
// ---------------------------------------------------------------------------

interface JournalEntry {
  cycleNumber: number;
  date: string;
  attempted: string;
  succeeded: string;
  failed: string;
  learnings: string;
}

function renderJournalSection(entries: JournalEntry[]): string {
  if (entries.length === 0) return "";

  const cards = entries.map((entry) => {
    const parts: string[] = [];
    if (entry.attempted) {
      parts.push(`<div class="journal-field"><span class="journal-label">Attempted</span><p>${escapeHtml(entry.attempted)}</p></div>`);
    }
    if (entry.succeeded) {
      parts.push(`<div class="journal-field"><span class="journal-label succeeded-label">Succeeded</span><p>${escapeHtml(entry.succeeded)}</p></div>`);
    }
    if (entry.failed) {
      parts.push(`<div class="journal-field"><span class="journal-label failed-label">Failed</span><p>${escapeHtml(entry.failed)}</p></div>`);
    }
    if (entry.learnings) {
      parts.push(`<div class="journal-field"><span class="journal-label">Learnings</span><p>${escapeHtml(entry.learnings)}</p></div>`);
    }

    return `
    <details class="journal-card">
      <summary>
        <span class="cycle-badge">Cycle ${entry.cycleNumber}</span>
        <span class="cycle-date">${escapeHtml(entry.date)}</span>
      </summary>
      <div class="journal-body">
        ${parts.join("\n        ")}
      </div>
    </details>`;
  }).join("\n");

  return `
  <section class="section">
    <h2><span class="badge" style="background:#0891b2">📓 Recent Journal</span></h2>
    <p class="stats-note">Latest evolution cycle summaries (click to expand).</p>
    ${cards}
  </section>`;
}

// ---------------------------------------------------------------------------
// Full HTML page
// ---------------------------------------------------------------------------

function generateHtml(
  sections: RoadmapSection[],
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
    if (journalEntries.length > 0) {
      journalSection = renderJournalSection(journalEntries);
    }
    console.log(`[generate-pages] Loaded ${stats.totalCycles} cycles and ${journalEntries.length} journal entries from bloom.db`);
  } catch (err) {
    console.warn(`[generate-pages] Could not read bloom.db: ${err}`);
  }
} else {
  console.log("[generate-pages] bloom.db not found — skipping stats and journal sections");
}

const html = generateHtml(sections, generatedAt, statsSection, journalSection);

const docsDir = resolve(repoRoot, "docs");
if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });

const outPath = resolve(docsDir, "index.html");
writeFileSync(outPath, html, "utf-8");

console.log(`[generate-pages] Wrote ${outPath}`);
