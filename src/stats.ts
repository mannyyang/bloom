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
import { initDb, getCycleStats, formatCycleStats, getLatestCycleNumber } from "./db.js";
import { formatMemoryForPrompt } from "./memory.js";

// Matches the separator in orchestrator.ts — kept local to avoid importing the
// heavyweight orchestrator module solely for this display constant.
const CYCLE_SUMMARY_SEPARATOR = "========================================";

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
  const db = initDb();

  try {
    const output = generateStatsOutput(db, lastN);
    for (const line of output) {
      console.log(line);
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
