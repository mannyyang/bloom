/**
 * generate-pages.ts
 * Reads ROADMAP.md and writes docs/index.html for GitHub Pages.
 *
 * Usage:  tsx scripts/generate-pages.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Minimal types (inlined to avoid a src/ import in a script)
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
// HTML generation
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

function generateHtml(sections: RoadmapSection[], generatedAt: string): string {
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
    footer { color: #9ca3af; font-size: 0.8rem; text-align: center; margin-top: 3rem; }
  </style>
</head>
<body>
  <header>
    <h1>🌸 Bloom Evolution Roadmap</h1>
    <p>Last updated: ${escapeHtml(generatedAt)}</p>
  </header>
  ${sectionsHtml}
  <footer>Generated from <code>ROADMAP.md</code> · <a href="https://github.com/anthropics/bloom" style="color:#9ca3af">github.com/anthropics/bloom</a></footer>
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
const html = generateHtml(sections, generatedAt);

const docsDir = resolve(repoRoot, "docs");
if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });

const outPath = resolve(docsDir, "index.html");
writeFileSync(outPath, html, "utf-8");

console.log(`[generate-pages] Wrote ${outPath}`);
