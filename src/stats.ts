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
import { initDb, getCycleStats, formatCycleStats, getLatestCycleNumber, getCycleRows, CYCLE_SUMMARY_SEPARATOR, type CycleStats, type CycleRow } from "./db.js";
import { formatMemoryForPrompt } from "./memory.js";

/**
 * Number of characters of memory to include in the stats preview.
 * Intentionally less than MAX_MEMORY_CHARS (1200) — the stats CLI shows a
 * condensed snapshot rather than the full prompt context.
 */
export const STATS_MEMORY_PREVIEW_CHARS = 1000;

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

/** Column widths for the ASCII stats table. */
const COL_CYCLE = 6;
const COL_ATTEMPTED = 9;
const COL_SUCCEEDED = 9;
const COL_BUILD = 6;
const COL_PUSH = 5;
const COL_DURATION = 10;

function pad(s: string, width: number, right = false): string {
  return right ? s.padStart(width) : s.padEnd(width);
}

/**
 * Render per-cycle data as a fixed-width ASCII table.
 * Rows are ordered newest-first (highest cycle number at top).
 * Returns an empty string when no cycles exist.
 */
export function generateStatsTable(db: Database.Database, lastN?: number): string {
  const rows = getCycleRows(db, lastN);
  if (rows.length === 0) return "";

  const header = [
    pad("Cycle", COL_CYCLE, true),
    pad("Attempt", COL_ATTEMPTED, true),
    pad("Succeed", COL_SUCCEEDED, true),
    pad("Build", COL_BUILD),
    pad("Push", COL_PUSH),
    pad("Duration", COL_DURATION, true),
  ].join("  ");

  const separator = [
    "-".repeat(COL_CYCLE),
    "-".repeat(COL_ATTEMPTED),
    "-".repeat(COL_SUCCEEDED),
    "-".repeat(COL_BUILD),
    "-".repeat(COL_PUSH),
    "-".repeat(COL_DURATION),
  ].join("  ");

  const dataRows = rows.map((r: CycleRow) => {
    const durationStr = r.durationMs !== null
      ? `${(r.durationMs / 60_000).toFixed(1)} min`
      : "—";
    return [
      pad(String(r.cycleNumber), COL_CYCLE, true),
      pad(String(r.attempted), COL_ATTEMPTED, true),
      pad(String(r.succeeded), COL_SUCCEEDED, true),
      pad(r.buildPassed ? "✓" : "✗", COL_BUILD),
      pad(r.pushed ? "✓" : "✗", COL_PUSH),
      pad(durationStr, COL_DURATION, true),
    ].join("  ");
  });

  return [header, separator, ...dataRows].join("\n");
}

/**
 * Machine-readable JSON output for CI automation, dashboards, and scripting.
 * Returns the latest cycle number alongside the raw CycleStats object.
 * The `window` field records the lastN argument used to compute stats (null
 * means all-time), making the output self-describing for dashboard consumers.
 * When no cycles exist, latestCycle is 0 and stats contains zero-value fields.
 */
export function generateStatsJson(
  db: Database.Database,
  lastN?: number,
): { latestCycle: number; window: number | null; generatedAt: string; stats: CycleStats } {
  const latestCycle = getLatestCycleNumber(db);
  const stats = getCycleStats(db, lastN);
  return { latestCycle, window: lastN ?? null, generatedAt: new Date().toISOString(), stats };
}

/**
 * Core stats logic, accepting a db parameter for testability.
 * Returns the lines that would be printed to console.
 * @param lastN - optional override for how many recent cycles to summarise
 */
export function generateStatsOutput(db: Database.Database, lastN?: number): string[] {
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
  lines.push("  Bloom Evolution Statistics");
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

  lines.push("");

  return lines;
}

function main() {
  const lastN = parseLastNArg(process.argv);
  const jsonMode = parseJsonFlag(process.argv);
  const tableMode = parseTableFlag(process.argv);
  const db = initDb();

  try {
    if (jsonMode) {
      const result = generateStatsJson(db, lastN);
      console.log(JSON.stringify(result, null, 2));
    } else if (tableMode) {
      const table = generateStatsTable(db, lastN);
      console.log(table || "No evolution cycles recorded yet.");
    } else {
      const output = generateStatsOutput(db, lastN);
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
