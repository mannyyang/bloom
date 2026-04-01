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
