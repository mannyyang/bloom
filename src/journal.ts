/**
 * CLI entry point for exporting Bloom's journal entries.
 * Outputs journal data as JSON (default) or Markdown to stdout.
 *
 * Usage:
 *   pnpm journal              # JSON output
 *   pnpm journal -- --md      # Markdown output
 *   pnpm journal -- --limit 5 # Limit entries
 *
 * Addresses community issue #13: "the public github page for the journal
 * seems broken, there's no new updates."
 */

import type Database from "better-sqlite3";
import { initDb, exportJournalJson, type JournalExportEntry } from "./db.js";

/**
 * Format journal entries as Markdown.
 */
export function formatJournalMarkdown(entries: JournalExportEntry[]): string {
  if (entries.length === 0) {
    return "No journal entries recorded yet.";
  }

  const lines: string[] = ["# Bloom Evolution Journal", ""];

  for (const entry of entries) {
    lines.push(`## Cycle ${entry.cycleNumber} — ${entry.date}`);
    lines.push("");
    if (entry.attempted) {
      lines.push("### What was attempted");
      lines.push(entry.attempted);
      lines.push("");
    }
    if (entry.succeeded) {
      lines.push("### What succeeded");
      lines.push(entry.succeeded);
      lines.push("");
    }
    if (entry.failed) {
      lines.push("### What failed");
      lines.push(entry.failed);
      lines.push("");
    }
    if (entry.learnings) {
      lines.push("### Learnings");
      lines.push(entry.learnings);
      lines.push("");
    }
    if (entry.strategic_context) {
      lines.push("### Strategic Context");
      lines.push(entry.strategic_context);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Core journal export logic, accepting a db parameter for testability.
 * Returns the string that would be printed to stdout.
 */
export function generateJournalOutput(
  db: Database.Database,
  options: { format?: "json" | "md"; limit?: number } = {},
): string {
  const { format = "json", limit } = options;
  let entries = exportJournalJson(db);

  if (limit && limit > 0) {
    entries = entries.slice(0, limit);
  }

  if (format === "md") {
    return formatJournalMarkdown(entries);
  }

  return JSON.stringify(entries, null, 2);
}

function parseArgs(argv: string[]): { format: "json" | "md"; limit?: number } {
  const format = argv.includes("--md") ? "md" as const : "json" as const;
  const limitIdx = argv.indexOf("--limit");
  const limit = limitIdx !== -1 && argv[limitIdx + 1]
    ? parseInt(argv[limitIdx + 1], 10)
    : undefined;
  return { format, limit: limit && !isNaN(limit) ? limit : undefined };
}

function main() {
  const db = initDb();

  try {
    const options = parseArgs(process.argv.slice(2));
    const output = generateJournalOutput(db, options);
    console.log(output);
  } finally {
    db.close();
  }
}

// Only run when executed directly as a CLI script, not when imported
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isDirectRun) {
  main();
}
