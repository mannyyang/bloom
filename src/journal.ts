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
import { csvQuoteField } from "./csv.js";

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
  --format <fmt>    Output format: json (default), md, or csv
  --md              Shorthand for --format md
  --limit <N>       Limit output to the most recent N entries
  --since <CYCLE>   Show only entries from cycle CYCLE onwards (inclusive)
  --cycle <N>       Show the journal entry for exactly one specific cycle
  --search <term>   Filter entries by case-insensitive keyword search across all text fields
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
 * Serialize journal entries as RFC 4180 CSV.
 * The first row is a fixed header; subsequent rows are one entry each.
 * An empty entries array produces a header-only output (still RFC 4180 valid).
 */
export function generateJournalCsv(entries: JournalExportEntry[]): string {
  const HEADER = "cycleNumber,date,attempted,succeeded,failed,learnings,strategic_context";
  const lines: string[] = [HEADER];
  for (const entry of entries) {
    lines.push([
      csvQuoteField(String(entry.cycleNumber)),
      csvQuoteField(entry.date),
      csvQuoteField(entry.attempted),
      csvQuoteField(entry.succeeded),
      csvQuoteField(entry.failed),
      csvQuoteField(entry.learnings),
      csvQuoteField(entry.strategic_context),
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * Filter journal entries by a case-insensitive search term across all text fields.
 * Returns the entries that contain the term in any of: attempted, succeeded, failed,
 * learnings, or strategic_context.
 */
function filterEntriesBySearch(entries: JournalExportEntry[], term: string): JournalExportEntry[] {
  const lower = term.toLowerCase();
  return entries.filter((entry) =>
    [entry.attempted, entry.succeeded, entry.failed, entry.learnings, entry.strategic_context]
      .some((field) => field != null && field.toLowerCase().includes(lower)),
  );
}

/**
 * Core journal export logic, accepting a db parameter for testability.
 * Returns the string that would be printed to stdout.
 */
export function generateJournalOutput(
  db: Database.Database,
  options: { format?: "json" | "md" | "csv"; limit?: number; since?: number; cycle?: number; search?: string } = {},
): string {
  const { format = "json", limit, since, cycle, search } = options;
  // Math.floor normalises fractional values (e.g. 3.7 → 3).
  // The explicit `!== undefined` guard makes intent clear: 0 is not a valid
  // limit (pass undefined to mean "no limit"), and `safeLimit > 0` already
  // handles that — no need for a falsy short-circuit.
  const safeLimit = limit !== undefined ? Math.floor(limit) : undefined;
  // Pass `since` into exportJournalJson so the SQL WHERE clause filters before
  // LIMIT is applied — `--limit 5 --since 700` now returns the 5 most-recent
  // entries that are >= cycle 700, not the 5 most-recent entries overall.
  const safeSince = since !== undefined && since > 0 ? since : undefined;
  // --cycle N takes precedence over --since: it pins to exactly one cycle.
  const safeCycle = cycle !== undefined && cycle > 0 ? cycle : undefined;
  let entries = exportJournalJson(db, safeLimit !== undefined && safeLimit > 0 ? safeLimit : undefined, safeSince, safeCycle);

  // Apply --search filter post-fetch (pure JS, no schema changes needed).
  if (search && search.trim().length > 0) {
    entries = filterEntriesBySearch(entries, search.trim());
  }

  if (format === "md") {
    return formatJournalMarkdown(entries);
  }

  if (format === "csv") {
    return generateJournalCsv(entries);
  }

  return JSON.stringify(entries, null, 2);
}

export function parseArgs(argv: string[]): { format: "json" | "md" | "csv"; limit?: number; since?: number; cycle?: number; search?: string } {
  let format: "json" | "md" | "csv" = "json";
  // --format <fmt> takes precedence; unknown values fall back to "json"
  const formatFlagIdx = argv.indexOf("--format");
  if (formatFlagIdx !== -1 && argv[formatFlagIdx + 1]) {
    const val = argv[formatFlagIdx + 1];
    if (val === "csv" || val === "md") {
      format = val;
    }
  } else if (argv.includes("--md")) {
    // Legacy shorthand kept for backward compatibility
    format = "md";
  }
  // --search <term>: capture the raw string value following the flag.
  let search: string | undefined;
  const searchIdx = argv.indexOf("--search");
  if (searchIdx !== -1 && argv[searchIdx + 1] && !argv[searchIdx + 1].startsWith("--")) {
    search = argv[searchIdx + 1];
  }
  return {
    format,
    limit: parseIntArg(argv, "--limit"),
    since: parseIntArg(argv, "--since"),
    cycle: parseIntArg(argv, "--cycle"),
    search,
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
