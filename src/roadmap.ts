/**
 * CLI entry point for viewing Bloom's current evolution roadmap.
 * Reads ROADMAP.md and prints a formatted summary of all items by status.
 *
 * Usage: pnpm roadmap
 *
 * Mirrors the pattern of `pnpm stats` and `pnpm journal`, giving humans
 * a quick way to inspect planning state without reading raw Markdown.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  parseRoadmap,
  readRoadmap,
  type StatusColumn,
} from "./planning.js";

// Re-export for testability
export { generateRoadmapOutput };

export const ROADMAP_BODY_PREVIEW_MAX_CHARS = 120;

const STATUS_ORDER: StatusColumn[] = ["In Progress", "Up Next", "Backlog", "Done"];

/**
 * Core roadmap display logic, accepting raw markdown for testability.
 * Returns the lines that would be printed to the console.
 */
function generateRoadmapOutput(content: string): string[] {
  const items = parseRoadmap(content);
  const lines: string[] = [];

  lines.push("");
  lines.push("========================================");
  lines.push("  Bloom Evolution Roadmap");
  lines.push("========================================");

  for (const status of STATUS_ORDER) {
    const statusItems = items.filter((i) => i.status === status);
    if (statusItems.length === 0) continue;

    lines.push("");
    lines.push(`  ${status.toUpperCase()}`);
    lines.push("  " + "-".repeat(status.length));

    for (const item of statusItems) {
      const issue = item.linkedIssueNumber ? ` (#${item.linkedIssueNumber})` : "";
      const reactions = item.reactions > 0 ? ` [${item.reactions} ★]` : "";
      const check = item.status === "Done" ? "✓" : "○";
      lines.push(`  ${check} ${item.title}${issue}${reactions}`);
      if (item.body) {
        // Indent and wrap the body description
        const preview = item.body.length > ROADMAP_BODY_PREVIEW_MAX_CHARS ? item.body.slice(0, ROADMAP_BODY_PREVIEW_MAX_CHARS) + "…" : item.body;
        for (const bodyLine of preview.split("\n")) {
          lines.push(`      ${bodyLine}`);
        }
      }
    }
  }

  if (items.length === 0) {
    lines.push("");
    lines.push("  No items on the roadmap yet.");
  }

  lines.push("");
  return lines;
}

function main() {
  // Read the roadmap file using planning module's path resolution
  const content = readRoadmap();

  const output = generateRoadmapOutput(content);
  for (const line of output) {
    console.log(line);
  }
}

// Only run when executed directly as a CLI script, not when imported
const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  main();
}
