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

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import {
  initDb,
  exportJournalJson,
  type JournalExportEntry,
  JOURNAL_ATTEMPTED_HEADER,
  JOURNAL_SUCCEEDED_HEADER,
  JOURNAL_FAILED_HEADER,
  JOURNAL_LEARNINGS_HEADER,
  JOURNAL_STRATEGIC_CONTEXT_HEADER,
} from "./db.js";

export {
  JOURNAL_ATTEMPTED_HEADER,
  JOURNAL_SUCCEEDED_HEADER,
  JOURNAL_FAILED_HEADER,
  JOURNAL_LEARNINGS_HEADER,
  JOURNAL_STRATEGIC_CONTEXT_HEADER,
};

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
      lines.push(JOURNAL_ATTEMPTED_HEADER);
      lines.push(entry.attempted);
      lines.push("");
    }
    if (entry.succeeded) {
      lines.push(JOURNAL_SUCCEEDED_HEADER);
      lines.push(entry.succeeded);
      lines.push("");
    }
    if (entry.failed) {
      lines.push(JOURNAL_FAILED_HEADER);
      lines.push(entry.failed);
      lines.push("");
    }
    if (entry.learnings) {
      lines.push(JOURNAL_LEARNINGS_HEADER);
      lines.push(entry.learnings);
      lines.push("");
    }
    if (entry.strategic_context) {
      lines.push(JOURNAL_STRATEGIC_CONTEXT_HEADER);
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
  const safeLimit = limit !== undefined ? Math.floor(limit) : undefined;
  const entries = exportJournalJson(db, safeLimit && safeLimit > 0 ? safeLimit : undefined);

  if (format === "md") {
    return formatJournalMarkdown(entries);
  }

  return JSON.stringify(entries, null, 2);
}

export function parseArgs(argv: string[]): { format: "json" | "md"; limit?: number } {
  const format = argv.includes("--md") ? "md" as const : "json" as const;
  const limitIdx = argv.indexOf("--limit");
  const limit = limitIdx !== -1 && argv[limitIdx + 1]
    ? parseInt(argv[limitIdx + 1], 10)
    : undefined;
  return { format, limit: limit && !isNaN(limit) && limit > 0 ? limit : undefined };
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
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  main();
}
