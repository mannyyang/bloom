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
import { parseHelpFlag, parseIntArg } from "./stats.js";

export {
  JOURNAL_ATTEMPTED_HEADER,
  JOURNAL_SUCCEEDED_HEADER,
  JOURNAL_FAILED_HEADER,
  JOURNAL_LEARNINGS_HEADER,
  JOURNAL_STRATEGIC_CONTEXT_HEADER,
};

/**
 * Usage text printed when `pnpm journal --help` is invoked.
 * Lists every supported flag with a short description, mirroring the
 * convention used by `pnpm stats --help` and `pnpm roadmap --help`.
 */
export const JOURNAL_HELP_TEXT = `\
Usage: pnpm journal [options]

Options:
  --md              Output journal as Markdown instead of JSON
  --limit <N>       Limit output to the most recent N entries
  --since <CYCLE>   Show only entries from cycle CYCLE onwards (inclusive)
  --help, -h        Print this help message and exit
`;

/**
 * Append a Markdown section (header + content + blank line) to `lines`
 * if `content` is non-empty. Centralises the triple-push pattern used by
 * every optional section in formatJournalMarkdown.
 */
function pushSection(lines: string[], header: string, content: string | null | undefined): void {
  if (content) {
    lines.push(header);
    lines.push(content.replace(/\r\n/g, "\n"));
    lines.push("");
  }
}

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
    pushSection(lines, JOURNAL_ATTEMPTED_HEADER, entry.attempted);
    pushSection(lines, JOURNAL_SUCCEEDED_HEADER, entry.succeeded);
    pushSection(lines, JOURNAL_FAILED_HEADER, entry.failed);
    pushSection(lines, JOURNAL_LEARNINGS_HEADER, entry.learnings);
    pushSection(lines, JOURNAL_STRATEGIC_CONTEXT_HEADER, entry.strategic_context);
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
  options: { format?: "json" | "md"; limit?: number; since?: number } = {},
): string {
  const { format = "json", limit, since } = options;
  // Math.floor normalises fractional values (e.g. 3.7 → 3).
  // The explicit `!== undefined` guard makes intent clear: 0 is not a valid
  // limit (pass undefined to mean "no limit"), and `safeLimit > 0` already
  // handles that — no need for a falsy short-circuit.
  const safeLimit = limit !== undefined ? Math.floor(limit) : undefined;
  // Pass `since` into exportJournalJson so the SQL WHERE clause filters before
  // LIMIT is applied — `--limit 5 --since 700` now returns the 5 most-recent
  // entries that are >= cycle 700, not the 5 most-recent entries overall.
  const safeSince = since !== undefined && since > 0 ? since : undefined;
  const entries = exportJournalJson(db, safeLimit !== undefined && safeLimit > 0 ? safeLimit : undefined, safeSince);

  if (format === "md") {
    return formatJournalMarkdown(entries);
  }

  return JSON.stringify(entries, null, 2);
}

export function parseArgs(argv: string[]): { format: "json" | "md"; limit?: number; since?: number } {
  const format = argv.includes("--md") ? "md" as const : "json" as const;
  return {
    format,
    limit: parseIntArg(argv, "--limit"),
    since: parseIntArg(argv, "--since"),
  };
}

function main() {
  if (parseHelpFlag(process.argv)) {
    process.stdout.write(JOURNAL_HELP_TEXT);
    return;
  }

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
