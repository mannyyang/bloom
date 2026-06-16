/**
 * CLI entry point for viewing Bloom's evolution statistics.
 * Opens the database read-only and prints cycle stats.
 *
 * Usage: pnpm stats
 *
 * Addresses community issues #1 ("what's the goal?") and #3 ("how are you measuring success?")
 * by making success metrics queryable outside the evolution loop.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { initDb, getCycleStats, formatCycleStats, getLatestCycleNumber, getCycleRows, getLastUpdatedCyclePerCategory, CYCLE_SUMMARY_SEPARATOR, MS_PER_MINUTE, type CycleStats, type CycleRow, type CategoryStaleness } from "./db.js";
import { formatMemoryForPrompt } from "./memory.js";

/**
 * Number of characters of memory to include in the stats preview.
 * Intentionally less than MAX_MEMORY_CHARS (1200) — the stats CLI shows a
 * condensed snapshot rather than the full prompt context.
 */
export const STATS_MEMORY_PREVIEW_CHARS = 1000;

/**
 * Symbol rendered in the verbose table Failures column when a cycle has no
 * recorded failure category (i.e. failureCategory is "none" or absent).
 * Named so future changes to the symbol are auditable in one place.
 */
export const STATS_NO_FAILURE_SYMBOL = "—";

/**
 * Symbol rendered in the Duration column when a cycle's durationMs is null
 * (i.e. the cycle completed without recording a duration).
 * Aliased to STATS_NO_FAILURE_SYMBOL so both columns always share the same
 * "no value" glyph — a future symbol change only needs to happen in one place.
 */
export const STATS_NO_DURATION_SYMBOL = STATS_NO_FAILURE_SYMBOL;

/**
 * Parse `--last N` from an argv array, returning N as a positive integer or
 * undefined when the flag is absent, missing a value, or the value is invalid.
 */
export function parseLastNArg(argv: string[]): number | undefined {
  const idx = argv.indexOf("--last");
  if (idx === -1) return undefined;
  const val = parseInt(argv[idx + 1] ?? "", 10);
  return !isNaN(val) && val > 0 ? val : undefined;
}

/**
 * Parse `--json` from an argv array, returning true when the flag is present.
 * Mirrors the pattern of parseLastNArg for consistency.
 */
export function parseJsonFlag(argv: string[]): boolean {
  return argv.includes("--json");
}

/**
 * Parse `--table` from an argv array, returning true when the flag is present.
 * Mirrors the pattern of parseJsonFlag for consistency.
 */
export function parseTableFlag(argv: string[]): boolean {
  return argv.includes("--table");
}

/**
 * Parse `--verbose` from an argv array, returning true when the flag is present.
 * When combined with `--table`, adds a Failures column to the ASCII table.
 */
export function parseVerboseFlag(argv: string[]): boolean {
  return argv.includes("--verbose");
}

/** Column widths for the ASCII stats table. */
const COL_CYCLE = 6;
const COL_ATTEMPTED = 9;
const COL_SUCCEEDED = 9;
const COL_BUILD = 6;
const COL_PUSH = 5;
const COL_DURATION = 10;
const COL_FAILURES = 16;

function pad(s: string, width: number, right = false): string {
  return right ? s.padStart(width) : s.padEnd(width);
}

/**
 * Render per-cycle data as a fixed-width ASCII table.
 * Rows are ordered newest-first (highest cycle number at top).
 * Returns an empty string when no cycles exist.
 * When `verbose` is true, appends a Failures column showing each row's
 * failure_category (rendered as "—" when the category is "none" or absent).
 */
export function generateStatsTable(db: Database.Database, lastN?: number, verbose?: boolean): string {
  const rows = getCycleRows(db, lastN);
  if (rows.length === 0) return "";

  const baseHeaderCells = [
    pad("Cycle", COL_CYCLE, true),
    pad("Attempt", COL_ATTEMPTED, true),
    pad("Succeed", COL_SUCCEEDED, true),
    pad("Build", COL_BUILD),
    pad("Push", COL_PUSH),
    pad("Duration", COL_DURATION, true),
  ];
  const baseSepCells = [
    "-".repeat(COL_CYCLE),
    "-".repeat(COL_ATTEMPTED),
    "-".repeat(COL_SUCCEEDED),
    "-".repeat(COL_BUILD),
    "-".repeat(COL_PUSH),
    "-".repeat(COL_DURATION),
  ];

  if (verbose) {
    baseHeaderCells.push(pad("Failures", COL_FAILURES));
    baseSepCells.push("-".repeat(COL_FAILURES));
  }

  const header = baseHeaderCells.join("  ");
  const separator = baseSepCells.join("  ");

  const dataRows = rows.map((r: CycleRow) => {
    const durationStr = r.durationMs !== null
      ? `${(r.durationMs / MS_PER_MINUTE).toFixed(1)} min`
      : STATS_NO_DURATION_SYMBOL;
    const cells = [
      pad(String(r.cycleNumber), COL_CYCLE, true),
      pad(String(r.attempted), COL_ATTEMPTED, true),
      pad(String(r.succeeded), COL_SUCCEEDED, true),
      pad(r.buildPassed ? "✓" : "✗", COL_BUILD),
      pad(r.pushed ? "✓" : "✗", COL_PUSH),
      pad(durationStr, COL_DURATION, true),
    ];
    if (verbose) {
      const cat = r.failureCategory && r.failureCategory !== "none" ? r.failureCategory : STATS_NO_FAILURE_SYMBOL;
      cells.push(pad(cat, COL_FAILURES));
    }
    return cells.join("  ");
  });

  return [header, separator, ...dataRows].join("\n");
}

/**
 * Machine-readable JSON output for CI automation, dashboards, and scripting.
 * Returns the latest cycle number alongside the raw CycleStats object.
 * The `window` field records the lastN argument used to compute stats (null
 * means all-time), making the output self-describing for dashboard consumers.
 * When no cycles exist, latestCycle is 0 and stats contains zero-value fields.
 * When `verbose` is true, includes a `learningsStaleness` array with per-category
 * staleness data (the most recent cycle in which each learning category was updated),
 * achieving output parity with the default and table modes.
 */
export function generateStatsJson(
  db: Database.Database,
  lastN?: number,
  verbose?: boolean,
): { latestCycle: number; window: number | null; generatedAt: string; stats: CycleStats; learningsStaleness?: CategoryStaleness[] } {
  const latestCycle = getLatestCycleNumber(db);
  const stats = getCycleStats(db, lastN);
  const result: { latestCycle: number; window: number | null; generatedAt: string; stats: CycleStats; learningsStaleness?: CategoryStaleness[] } = {
    latestCycle, window: lastN ?? null, generatedAt: new Date().toISOString(), stats,
  };
  if (verbose) {
    result.learningsStaleness = getLastUpdatedCyclePerCategory(db);
  }
  return result;
}

/**
 * Core stats logic, accepting a db parameter for testability.
 * Returns the lines that would be printed to console.
 * @param lastN - optional override for how many recent cycles to summarise
 * @param verbose - when true, appends a "Learnings staleness" block showing
 *   the most recent cycle in which each learning category was updated
 */
export function generateStatsOutput(db: Database.Database, lastN?: number, verbose?: boolean): string[] {
  const lines: string[] = [];

  const latestCycle = getLatestCycleNumber(db);
  if (latestCycle === 0) {
    lines.push("No evolution cycles recorded yet.");
    return lines;
  }

  const stats = getCycleStats(db, lastN);
  const formatted = formatCycleStats(stats);

  lines.push("");
  lines.push(CYCLE_SUMMARY_SEPARATOR);
  lines.push(`  Bloom Evolution Statistics${lastN !== undefined ? ` (last ${lastN} cycles)` : ""}`);
  lines.push(`  Latest cycle: ${latestCycle}`);
  lines.push(CYCLE_SUMMARY_SEPARATOR);
  lines.push("");
  lines.push(formatted);

  // Show latest strategic context if available
  const memory = formatMemoryForPrompt(db, STATS_MEMORY_PREVIEW_CHARS);
  if (memory) {
    lines.push("");
    lines.push(memory);
  }

  // When verbose, append a per-category staleness block
  if (verbose) {
    const staleness = getLastUpdatedCyclePerCategory(db);
    if (staleness.length > 0) {
      lines.push("");
      lines.push("Learnings staleness (by category):");
      for (const entry of staleness) {
        lines.push(`  ${entry.category}: last updated cycle ${entry.lastCycle}`);
      }
    }
  }

  lines.push("");

  return lines;
}

function main() {
  const lastN = parseLastNArg(process.argv);
  const jsonMode = parseJsonFlag(process.argv);
  const tableMode = parseTableFlag(process.argv);
  const verbose = parseVerboseFlag(process.argv);
  const db = initDb();

  try {
    if (jsonMode) {
      const result = generateStatsJson(db, lastN, verbose);
      console.log(JSON.stringify(result, null, 2));
    } else if (tableMode) {
      const table = generateStatsTable(db, lastN, verbose);
      console.log(table || "No evolution cycles recorded yet.");
    } else {
      const output = generateStatsOutput(db, lastN, verbose);
      for (const line of output) {
        console.log(line);
      }
    }
  } finally {
    db.close();
  }
}

// Only run when executed directly as a CLI script, not when imported
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  main();
}
