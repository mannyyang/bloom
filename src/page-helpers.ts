/**
 * page-helpers.ts
 * Pure helper functions shared by scripts/generate-pages.ts.
 * Exported so they can be unit-tested independently.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoadmapSection {
  heading: string;
  items: RoadmapItem[];
}

export interface RoadmapItem {
  done: boolean;
  title: string;
  issueNumber: number | null;
  description: string;
}

export interface JournalEntry {
  cycleNumber: number;
  date: string;
  attempted: string;
  succeeded: string;
  failed: string;
  learnings: string;
}

export interface DbStats {
  totalCycles: number;
  successRate: number;
  avgImprovements: number;
  avgConversionRate: number | null;
  recentFailures: number;
  avgDurationMinutes: number | null;
  totalCostUsd: number;
}

// ---------------------------------------------------------------------------
// Cross-page navigation
// ---------------------------------------------------------------------------

export type NavPage = "index" | "journal" | "stats";

export function renderNav(active: NavPage): string {
  const links: Array<{ id: NavPage; href: string; label: string }> = [
    { id: "index",   href: "index.html",   label: "🌸 Roadmap" },
    { id: "journal", href: "journal.html", label: "📓 Journal" },
    { id: "stats",   href: "stats.html",   label: "📊 Stats"   },
  ];
  const items = links
    .map(({ id, href, label }) => {
      const style = id === active
        ? 'style="color:#111827;font-weight:700;text-decoration:none;"'
        : 'style="color:#2563eb;text-decoration:none;"';
      return `<a href="${href}" ${style}>${escapeHtml(label)}</a>`;
    })
    .join(" · ");
  return `<nav style="margin-bottom:1.5rem;font-size:0.9rem;">${items}</nav>`;
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Parse ROADMAP.md
// ---------------------------------------------------------------------------

export function parseRoadmapSections(content: string): RoadmapSection[] {
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
// Roadmap section renderer
// ---------------------------------------------------------------------------

export const STATUS_COLORS: Record<string, string> = {
  Backlog: "#6b7280",
  "Up Next": "#2563eb",
  "In Progress": "#d97706",
  Done: "#16a34a",
};

export function renderSection(section: RoadmapSection): string {
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
// Stats section renderer
// ---------------------------------------------------------------------------

export function renderStatsSection(stats: DbStats): string {
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
// Journal renderers
// ---------------------------------------------------------------------------

export function renderJournalCards(entries: JournalEntry[]): string {
  return entries.map((entry) => {
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
    <details class="journal-card" open>
      <summary>
        <span class="cycle-badge">Cycle ${entry.cycleNumber}</span>
        <span class="cycle-date">${escapeHtml(entry.date)}</span>
      </summary>
      <div class="journal-body">
        ${parts.join("\n        ")}
      </div>
    </details>`;
  }).join("\n");
}

export function renderJournalSection(entries: JournalEntry[]): string {
  if (entries.length === 0) return "";

  const cards = renderJournalCards(entries);

  return `
  <section class="section">
    <h2><span class="badge" style="background:#0891b2">📓 Recent Journal</span></h2>
    <p class="stats-note">Latest evolution cycle summaries. <a href="journal.html">View full journal →</a></p>
    ${cards}
  </section>`;
}

// ---------------------------------------------------------------------------
// Full HTML page assemblers (pure — no file I/O)
// ---------------------------------------------------------------------------

/** Shared CSS fragments reused across the three pages. */
const CSS_BASE = `
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
    .badge {
      display: inline-block;
      color: #fff;
      font-size: 0.85rem;
      font-weight: 600;
      padding: 0.2rem 0.65rem;
      border-radius: 999px;
    }
    .section { margin-bottom: 2rem; }
    .section h2 { margin-bottom: 0.75rem; }
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
    .stats-note { color: #6b7280; font-size: 0.85rem; margin-bottom: 0.75rem; }
    .stats-table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e7eb; border-radius: 0.5rem; overflow: hidden; }
    .stats-table td { padding: 0.5rem 0.9rem; font-size: 0.9rem; border-bottom: 1px solid #f3f4f6; }
    .stats-table tr:last-child td { border-bottom: none; }
    .stats-table td:first-child { color: #6b7280; width: 60%; }
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
    footer { color: #9ca3af; font-size: 0.8rem; text-align: center; margin-top: 3rem; }`;

const FOOTER_LINK = `Generated from <code>ROADMAP.md</code> + <code>bloom.db</code> · <a href="https://github.com/anthropics/bloom" style="color:#9ca3af">github.com/anthropics/bloom</a>`;

export function generateHtml(
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
  <style>${CSS_BASE}
  </style>
</head>
<body>
  ${renderNav("index")}
  <header>
    <h1>🌸 Bloom Evolution Roadmap</h1>
    <p>Last updated: ${escapeHtml(generatedAt)}</p>
  </header>
  ${sectionsHtml}
  ${statsSection}
  ${journalSection}
  <footer>${FOOTER_LINK}</footer>
</body>
</html>
`;
}

export function generateJournalHtml(
  entries: JournalEntry[],
  generatedAt: string,
): string {
  const cards = entries.length > 0 ? renderJournalCards(entries) : "<p>No journal entries yet.</p>";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bloom Full Journal</title>
  <style>${CSS_BASE}
  </style>
</head>
<body>
  ${renderNav("journal")}
  <header>
    <h1>📓 Bloom Full Journal</h1>
    <p>Last updated: ${escapeHtml(generatedAt)}</p>
  </header>
  <section>
    <p class="stats-note">All recorded evolution cycle summaries.</p>
    ${cards}
  </section>
  <footer>${FOOTER_LINK}</footer>
</body>
</html>
`;
}

export function generateStatsHtml(stats: DbStats | null, generatedAt: string): string {
  const statsContent = stats
    ? renderStatsSection(stats)
    : `<section class="section"><p class="stats-note">No stats available yet.</p></section>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bloom Cycle Stats</title>
  <style>${CSS_BASE}
  </style>
</head>
<body>
  ${renderNav("stats")}
  <header>
    <h1>📊 Bloom Cycle Stats</h1>
    <p>Last updated: ${escapeHtml(generatedAt)}</p>
  </header>
  ${statsContent}
  <footer>${FOOTER_LINK}</footer>
</body>
</html>
`;
}
