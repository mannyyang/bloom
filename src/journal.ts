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
import { parseHelpFlag, parseIntArg, parseSearchArg } from "./stats.js";
import { csvQuoteField, filterBySearchTerm } from "./csv.js";

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
  --format <fmt>    Output format: json (default), md, csv, or table
  --md              Shorthand for --format md
  --limit <N>       Limit output to the most recent N entries
  --since <CYCLE>   Show only entries from cycle CYCLE onwards (inclusive)
  --cycle <N>       Show the journal entry for exactly one specific cycle
  --search <term>   Filter entries by case-insensitive keyword search across all text fields
  --verbose         Show summary metadata (entry count and cycle range)
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

/** Column widths for the ASCII journal summary table. */
const JCOL_CYCLE = 6;
const JCOL_DATE = 10;
const JCOL_ATTEMPTED = 40;
const JCOL_SUCCEEDED = 40;
const JCOL_FAILED = 20;

/**
 * Pad (and truncate with ellipsis) a string to a fixed column width.
 * Right-aligns numeric columns when `right` is true.
 */
function jpad(s: string, width: number, right = false): string {
  const truncated = s.length > width ? s.slice(0, width - 1) + "\u2026" : s;
  return right ? truncated.padStart(width) : truncated.padEnd(width);
}

/**
 * Render journal entries as a fixed-width ASCII summary table.
 * Columns: Cycle, Date, Attempted (first line, truncated), Succeeded (first line,
 * truncated), Failed (first line, truncated).
 * Returns an empty string when entries is empty.
 */
export function generateJournalTable(entries: JournalExportEntry[]): string {
  if (entries.length === 0) return "";

  const headerCells = [
    jpad("Cycle", JCOL_CYCLE, true),
    jpad("Date", JCOL_DATE),
    jpad("Attempted", JCOL_ATTEMPTED),
    jpad("Succeeded", JCOL_SUCCEEDED),
    jpad("Failed", JCOL_FAILED),
  ];
  const sepCells = [
    "-".repeat(JCOL_CYCLE),
    "-".repeat(JCOL_DATE),
    "-".repeat(JCOL_ATTEMPTED),
    "-".repeat(JCOL_SUCCEEDED),
    "-".repeat(JCOL_FAILED),
  ];

  const header = headerCells.join("  ");
  const separator = sepCells.join("  ");

  const firstLine = (text: string | null | undefined): string =>
    (text ?? "").split("\n")[0] ?? "";

  const dataRows = entries.map((e) => [
    jpad(String(e.cycleNumber), JCOL_CYCLE, true),
    jpad(e.date, JCOL_DATE),
    jpad(firstLine(e.attempted), JCOL_ATTEMPTED),
    jpad(firstLine(e.succeeded), JCOL_SUCCEEDED),
    jpad(firstLine(e.failed), JCOL_FAILED),
  ].join("  "));

  return [header, separator, ...dataRows].join("\n");
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
 * Core journal export logic, accepting a db parameter for testability.
 * Returns the string that would be printed to stdout.
 */
export function generateJournalOutput(
  db: Database.Database,
  options: { format?: "json" | "md" | "csv" | "table"; limit?: number; since?: number; cycle?: number; search?: string; verbose?: boolean } = {},
): string {
  const { format = "json", limit, since, cycle, search, verbose } = options;
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

  // Apply --search filter post-fetch via shared csv.ts helper.
  entries = filterBySearchTerm(
    entries,
    search ?? "",
    (e) => [e.attempted, e.succeeded, e.failed, e.learnings, e.strategic_context],
  );

  if (format === "md") {
    let mdOutput = formatJournalMarkdown(entries);
    if (verbose && entries.length > 0) {
      const cycleNumbers = entries.map((e) => e.cycleNumber);
      const minCycle = Math.min(...cycleNumbers);
      const maxCycle = Math.max(...cycleNumbers);
      const summaryLine = `Entries: ${entries.length} | Range: ${minCycle}–${maxCycle}`;
      mdOutput = mdOutput.replace(
        "# Bloom Evolution Journal\n",
        `# Bloom Evolution Journal\n${summaryLine}\n`,
      );
    }
    return mdOutput;
  }

  if (format === "csv") {
    return generateJournalCsv(entries);
  }

  if (format === "table") {
    const tableOutput = generateJournalTable(entries);
    if (!tableOutput) return "No journal entries recorded yet.";
    if (verbose && entries.length > 0) {
      const cycleNumbers = entries.map((e) => e.cycleNumber);
      const minCycle = Math.min(...cycleNumbers);
      const maxCycle = Math.max(...cycleNumbers);
      return `${tableOutput}\nEntries: ${entries.length} | Range: ${minCycle}–${maxCycle}`;
    }
    return tableOutput;
  }

  if (verbose) {
    const cycleNumbers = entries.map((e) => e.cycleNumber);
    return JSON.stringify(
      {
        totalEntries: entries.length,
        cycleRange: entries.length > 0
          ? { min: Math.min(...cycleNumbers), max: Math.max(...cycleNumbers) }
          : null,
        entries,
      },
      null,
      2,
    );
  }

  return JSON.stringify(entries, null, 2);
}

export function parseArgs(argv: string[]): { format: "json" | "md" | "csv" | "table"; limit?: number; since?: number; cycle?: number; search?: string; verbose?: boolean } {
  let format: "json" | "md" | "csv" | "table" = "json";
  // --format <fmt> takes precedence; unknown values fall back to "json"
  const formatFlagIdx = argv.indexOf("--format");
  if (formatFlagIdx !== -1 && argv[formatFlagIdx + 1]) {
    const val = argv[formatFlagIdx + 1];
    if (val === "csv" || val === "md" || val === "table") {
      format = val;
    }
  } else if (argv.includes("--md")) {
    // Legacy shorthand kept for backward compatibility
    format = "md";
  }
  return {
    format,
    limit: parseIntArg(argv, "--limit"),
    since: parseIntArg(argv, "--since"),
    cycle: parseIntArg(argv, "--cycle"),
    search: parseSearchArg(argv),
    verbose: argv.includes("--verbose") ? true : undefined,
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
