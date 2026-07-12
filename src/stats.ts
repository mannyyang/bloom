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
import { readRoadmap, parseRoadmap, pickNextItemWithRationale } from "./planning.js";
import { errorMessage, ERROR_CATEGORY_NONE } from "./errors.js";
import { DANGEROUS_PATTERNS } from "./safety.js";
import { csvQuoteField } from "./csv.js";

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
 * Section header rendered in verbose output before the next-item selection
 * rationale. Extracted as a constant so tests can pin the exact string and
 * a future wording change is auditable in one place.
 */
export const STATS_NEXT_ITEM_HEADER = "Next item selection:";

/**
 * Fallback message rendered inside the next-item selection block when the
 * roadmap has no actionable items (pickNextItemWithRationale returns
 * rationale: null). Extracted as a constant to mirror the
 * STATS_NO_FAILURE_SYMBOL / STATS_NO_DURATION_SYMBOL pattern.
 */
export const STATS_NO_ACTIONABLE_ITEMS_MSG = "No actionable items on the roadmap.";

/**
 * Shared implementation for flag-followed-by-integer argv parsing.
 * Returns the positive integer after `flag`, or undefined when the flag is
 * absent, its value is missing, or the value is not a positive integer.
 * Exported so other CLI modules (e.g. journal.ts) can reuse this logic
 * without duplicating the indexOf → parseInt → validate pattern.
 */
export function parseIntArg(argv: string[], flag: string): number | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  const raw = argv[idx + 1] ?? "";
  if (!/^\d+$/.test(raw)) return undefined;
  const val = parseInt(raw, 10);
  return val > 0 ? val : undefined;
}

/**
 * Parse `--last N` from an argv array, returning N as a positive integer or
 * undefined when the flag is absent, missing a value, or the value is invalid.
 */
export function parseLastNArg(argv: string[]): number | undefined {
  return parseIntArg(argv, "--last");
}

/**
 * Parse `--since N` from an argv array, returning N as a positive integer
 * representing a minimum cycle number (inclusive), or undefined when the flag
 * is absent, missing a value, or the value is invalid.
 * Mirrors the pattern of parseLastNArg for consistency.
 */
export function parseSinceArg(argv: string[]): number | undefined {
  return parseIntArg(argv, "--since");
}

/**
 * Parse `--category CATEGORY` from an argv array, returning the category
 * string (e.g. "build_failure", "test_failure", "llm_error", "none") or
 * undefined when the flag is absent or its value is missing.
 * The value is not validated against known ErrorCategory constants so that
 * callers can filter by any category string, including future additions.
 */
export function parseCategoryArg(argv: string[]): string | undefined {
  const idx = argv.indexOf("--category");
  if (idx === -1) return undefined;
  const val = argv[idx + 1];
  return val && !val.startsWith("--") ? val : undefined;
}

/**
 * Parse `--search <term>` from an argv array, returning the search string when
 * present and non-empty, or undefined when the flag is absent, its value is
 * missing, or the value starts with `--` (i.e. is another flag rather than
 * a search term).
 * Exported so journal.ts and roadmap.ts can share this logic without each
 * duplicating the same indexOf → guard → return pattern.
 */
export function parseSearchArg(argv: string[]): string | undefined {
  const idx = argv.indexOf("--search");
  if (idx === -1) return undefined;
  const val = argv[idx + 1];
  if (!val || val.startsWith("--")) return undefined;
  return val;
}

/**
 * Parse `--trend N` from an argv array, returning N as a positive integer or
 * undefined when the flag is absent, missing a value, or the value is invalid.
 * N controls how many of the most-recent cycles are rendered in the trend bar.
 */
export function parseTrendArg(argv: string[]): number | undefined {
  return parseIntArg(argv, "--trend");
}

/**
 * Parse `--cost-alert <USD>` from an argv array, returning the threshold as a
 * non-negative finite number, or undefined when the flag is absent, its value
 * is missing, or the value is not a valid non-negative number.
 * Exported so tests can verify parsing without touching process.argv.
 */
export function parseCostAlertArg(argv: string[]): number | undefined {
  const idx = argv.indexOf("--cost-alert");
  if (idx === -1) return undefined;
  const raw = argv[idx + 1];
  if (!raw || raw.startsWith("--")) return undefined;
  const val = parseFloat(raw);
  if (!isFinite(val) || val < 0) return undefined;
  return val;
}

/**
 * Check whether `avgCostPerCycle` exceeds `threshold`.
 * Returns a human-readable warning string when the threshold is exceeded, or
 * null when the cost is within the threshold.
 * Exported for unit-testability so callers can assert the exact message format.
 */
export function checkCostAlert(avgCostPerCycle: number, threshold: number): string | null {
  if (avgCostPerCycle > threshold) {
    return `COST ALERT: avg cost/cycle $${avgCostPerCycle.toFixed(2)} exceeds threshold $${threshold.toFixed(2)}`;
  }
  return null;
}

/**
 * Parse `--json` from an argv array, returning true when the flag is present.
 * Mirrors the pattern of parseLastNArg for consistency.
 */
export function parseJsonFlag(argv: string[]): boolean {
  return argv.includes("--json");
}

/**
 * Parse `--csv` from an argv array, returning true when the flag is present.
 * When true, main() exports per-cycle rows as RFC 4180 CSV instead of the
 * default summary view. Parallel to --json but spreadsheet-friendly.
 */
export function parseCsvFlag(argv: string[]): boolean {
  return argv.includes("--csv");
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

/**
 * Parse `--help` from an argv array, returning true when the flag is present.
 * When true, main() prints STATS_HELP_TEXT and exits without querying the DB.
 */
export function parseHelpFlag(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/**
 * Usage text printed when `pnpm stats --help` is invoked.
 * Lists every supported flag with a short description, mirroring the
 * convention used by standard CLI tools.
 */
export const STATS_HELP_TEXT = `\
Usage: pnpm stats [options]

Options:
  --last <N>            Show stats for the last N cycles only
  --since <N>           Show stats starting from cycle number N (inclusive)
  --category <CAT>      Filter to cycles matching failure_category (e.g. build_failure, none)
  --trend <N>           Show an ASCII success-rate bar for the last N cycles
  --cost-alert <USD>    Warn and exit non-zero when avg cost/cycle exceeds threshold
  --json                Output raw stats as JSON (for scripting/CI)
  --csv                 Output per-cycle data as RFC 4180 CSV (spreadsheet-friendly)
  --table               Output per-cycle data as an ASCII table
  --verbose             Include extra detail (staleness data, safety pattern count, or Failures column)
  --help, -h            Print this help message and exit
`;

/** Column widths for the ASCII stats table. */
const COL_CYCLE = 6;
const COL_ATTEMPTED = 9;
const COL_SUCCEEDED = 9;
const COL_BUILD = 6;
const COL_PUSH = 5;
const COL_DURATION = 10;
/**
 * Width of the Cost column in the ASCII stats table.
 * Wide enough for "$999.99" (7 chars) plus padding.
 * Exported so tests can assert this invariant.
 */
export const COL_COST = 8;
/**
 * Width of the Failures column in the verbose ASCII table.
 * Must be >= the length of every ErrorCategory string so no category value
 * is silently truncated. Exported so tests can assert this invariant.
 */
export const COL_FAILURES = 16;

function pad(s: string, width: number, right = false): string {
  return right ? s.padStart(width) : s.padEnd(width);
}

/**
 * Compute the effective row-fetch limit to pass to getCycleStats / getCycleRows.
 *
 * When sinceN or categoryFilter is provided without an explicit lastN we must
 * fetch ALL rows (Number.MAX_SAFE_INTEGER) so the JavaScript-side filter can
 * see every matching cycle.  Using the default CYCLE_STATS_HISTORY_LIMIT (20)
 * would silently drop older cycles and produce incorrect aggregate totals.
 *
 * When lastN is explicit it is always honoured regardless of other filters.
 *
 * Exported so callers in stats.ts can share a single definition and a future
 * change to this policy only needs to happen in one place.
 */
export function computeEffectiveLimit(lastN?: number, sinceN?: number, categoryFilter?: string): number | undefined {
  if ((sinceN !== undefined || categoryFilter !== undefined) && lastN === undefined) {
    return Number.MAX_SAFE_INTEGER;
  }
  return lastN;
}

/**
 * Render per-cycle data as a fixed-width ASCII table.
 * Rows are ordered newest-first (highest cycle number at top).
 * Returns an empty string when no cycles exist.
 * When `verbose` is true, appends a Failures column showing each row's
 * failure_category (rendered as "—" when the category is "none" or absent).
 */
export function generateStatsTable(db: Database.Database, lastN?: number, verbose?: boolean, sinceN?: number, categoryFilter?: string): string {
  const effectiveLimit = computeEffectiveLimit(lastN, sinceN, categoryFilter);
  let rows = getCycleRows(db, effectiveLimit);
  if (sinceN !== undefined) {
    rows = rows.filter((r: CycleRow) => r.cycleNumber >= sinceN);
  }
  if (categoryFilter !== undefined) {
    rows = rows.filter((r: CycleRow) => (r.failureCategory ?? ERROR_CATEGORY_NONE) === categoryFilter);
  }
  if (rows.length === 0) return "";

  const baseHeaderCells = [
    pad("Cycle", COL_CYCLE, true),
    pad("Attempt", COL_ATTEMPTED, true),
    pad("Succeed", COL_SUCCEEDED, true),
    pad("Build", COL_BUILD),
    pad("Push", COL_PUSH),
    pad("Duration", COL_DURATION, true),
    pad("Cost", COL_COST, true),
  ];
  const baseSepCells = [
    "-".repeat(COL_CYCLE),
    "-".repeat(COL_ATTEMPTED),
    "-".repeat(COL_SUCCEEDED),
    "-".repeat(COL_BUILD),
    "-".repeat(COL_PUSH),
    "-".repeat(COL_DURATION),
    "-".repeat(COL_COST),
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
    const costStr = r.totalCostUsd > 0 ? `$${r.totalCostUsd.toFixed(2)}` : STATS_NO_FAILURE_SYMBOL;
    const cells = [
      pad(String(r.cycleNumber), COL_CYCLE, true),
      pad(String(r.attempted), COL_ATTEMPTED, true),
      pad(String(r.succeeded), COL_SUCCEEDED, true),
      pad(r.buildPassed ? "✓" : "✗", COL_BUILD),
      pad(r.pushed ? "✓" : "✗", COL_PUSH),
      pad(durationStr, COL_DURATION, true),
      pad(costStr, COL_COST, true),
    ];
    if (verbose) {
      const cat = r.failureCategory && r.failureCategory !== ERROR_CATEGORY_NONE ? r.failureCategory : STATS_NO_FAILURE_SYMBOL;
      cells.push(pad(cat, COL_FAILURES));
    }
    return cells.join("  ");
  });

  return [header, separator, ...dataRows].join("\n");
}

/**
 * CSV header row for generateStatsCsv output.
 * Columns match the CycleRow fields in declaration order.
 * Exported so tests can assert the exact header without hard-coding it twice.
 */
export const STATS_CSV_HEADER = "cycle,attempted,succeeded,build_passed,pushed,duration_ms,total_cost_usd,failure_category";

/**
 * Export per-cycle rows as RFC 4180 CSV using the shared csvQuoteField utility.
 * Produces a header row followed by one data row per cycle, newest-first.
 * Fields with commas, double-quotes, or newlines are automatically quoted.
 * Returns just the header row (no data rows) when rows is empty so the output
 * is always a valid CSV file that can be imported into a spreadsheet tool.
 *
 * @param rows - CycleRow array as returned by getCycleRows (newest-first)
 */
export function generateStatsCsvFromRows(rows: CycleRow[]): string {
  const lines: string[] = [STATS_CSV_HEADER];
  for (const r of rows) {
    const durationMs = r.durationMs !== null ? String(r.durationMs) : "";
    const fields = [
      csvQuoteField(String(r.cycleNumber)),
      csvQuoteField(String(r.attempted)),
      csvQuoteField(String(r.succeeded)),
      csvQuoteField(r.buildPassed ? "true" : "false"),
      csvQuoteField(r.pushed ? "true" : "false"),
      csvQuoteField(durationMs),
      csvQuoteField(r.totalCostUsd > 0 ? r.totalCostUsd.toFixed(4) : "0"),
      csvQuoteField(r.failureCategory ?? ""),
    ];
    lines.push(fields.join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * Generate RFC 4180 CSV from the database, applying the same lastN / sinceN /
 * categoryFilter logic used by generateStatsTable and generateStatsJson.
 * Returns a CSV string (always includes the header row, even when no cycles exist).
 */
export function generateStatsCsv(db: Database.Database, lastN?: number, sinceN?: number, categoryFilter?: string): string {
  const effectiveLimit = computeEffectiveLimit(lastN, sinceN, categoryFilter);
  let rows = getCycleRows(db, effectiveLimit);
  if (sinceN !== undefined) {
    rows = rows.filter((r: CycleRow) => r.cycleNumber >= sinceN);
  }
  if (categoryFilter !== undefined) {
    rows = rows.filter((r: CycleRow) => (r.failureCategory ?? ERROR_CATEGORY_NONE) === categoryFilter);
  }
  return generateStatsCsvFromRows(rows);
}

/**
 * Unicode block characters used in the trend bar, ordered from empty to full.
 * ▁ = least success, █ = full success.
 * Exported so tests can assert bar output without hard-coding the characters.
 */
export const TREND_BAR_CHARS = ["▁", "▃", "▅", "█"] as const;

/**
 * Render a compact ASCII trend bar from an array of CycleRows.
 * Rows are split into up to 4 equal-width groups (oldest → newest); each group's
 * success rate (buildPassed && pushed) maps to one of four block characters:
 *   0–25%  → ▁  (TREND_BAR_CHARS[0])
 *   26–50% → ▃  (TREND_BAR_CHARS[1])
 *   51–75% → ▅  (TREND_BAR_CHARS[2])
 *   76–100%→ █  (TREND_BAR_CHARS[3])
 * When rows.length < 4, each row forms its own group, preserving per-cycle
 * resolution. The trailing percentage reflects the overall success rate.
 * Returns a string of the form `▁▃▅█  60%` for use in generateStatsTrend.
 * Returns an empty string when rows is empty.
 */
export function renderTrendBar(rows: CycleRow[]): string {
  if (rows.length === 0) return "";
  const ordered = [...rows].reverse(); // oldest first
  const n = ordered.length;
  const numGroups = Math.min(n, 4);
  const segments: string[] = [];
  for (let i = 0; i < numGroups; i++) {
    const start = Math.floor((i * n) / numGroups);
    const end = Math.floor(((i + 1) * n) / numGroups);
    const group = ordered.slice(start, end);
    const successRate = group.filter(r => r.buildPassed && r.pushed).length / group.length;
    let char: string;
    if (successRate <= 0.25) char = TREND_BAR_CHARS[0];
    else if (successRate <= 0.50) char = TREND_BAR_CHARS[1];
    else if (successRate <= 0.75) char = TREND_BAR_CHARS[2];
    else char = TREND_BAR_CHARS[3];
    segments.push(char);
  }
  const successCount = rows.filter(r => r.buildPassed && r.pushed).length;
  const pct = Math.round((successCount / rows.length) * 100);
  return `${segments.join("")}  ${pct}%`;
}

/**
 * Generate a single-line trend summary showing the success rate of the last N cycles
 * as an ASCII bar plus a trailing percentage.
 * Returns "No evolution cycles recorded yet." when the database is empty.
 * The actual row count shown may be less than trendN when fewer cycles exist.
 */
export function generateStatsTrend(db: Database.Database, trendN: number): string {
  const rows = getCycleRows(db, trendN);
  if (rows.length === 0) return "No evolution cycles recorded yet.";
  const bar = renderTrendBar(rows);
  return `Trend (last ${rows.length}): ${bar}`;
}

/**
 * Shape of the object returned by generateStatsJson and serialised to stdout
 * in --json mode. Exported so tests and external consumers can reference the
 * type without duplicating the inline annotation.
 */
export interface StatsJsonOutput {
  latestCycle: number;
  window: number | null;
  since: number | null;
  /** Category filter applied to this output, or null when no filter was used. */
  category: string | null;
  generatedAt: string;
  stats: CycleStats;
  /**
   * Per-cycle rows matching the active filters (lastN / sinceN / categoryFilter).
   * Ordered newest-first, matching getCycleRows convention. Always present so
   * dashboards and CI can consume per-cycle data without parsing ASCII tables.
   */
  rows?: CycleRow[];
  learningsStaleness?: CategoryStaleness[];
  /** Next-item selection rationale from pickNextItemWithRationale (verbose only). null means no actionable items. */
  nextItemRationale?: string | null;
  /** Number of active DANGEROUS_PATTERNS entries (verbose only). Lets operators confirm safety coverage without reading source. */
  dangerousPatternsCount?: number;
  /**
   * Strategic context memory preview (verbose only). Mirrors the
   * formatMemoryForPrompt snippet shown in text-mode verbose output so
   * dashboard consumers using --json --verbose get a complete picture.
   * null when no memory has been recorded yet.
   */
  strategicContext?: string | null;
}

/**
 * Machine-readable JSON output for CI automation, dashboards, and scripting.
 * Returns the latest cycle number alongside the raw CycleStats object.
 * The `window` field records the lastN argument used to compute stats (null
 * means all-time), making the output self-describing for dashboard consumers.
 * When no cycles exist, latestCycle is 0 and stats contains zero-value fields.
 * When `verbose` is true, includes a `learningsStaleness` array with per-category
 * staleness data (the most recent cycle in which each learning category was updated),
 * and a `nextItemRationale` string from pickNextItemWithRationale (null when no
 * actionable items exist), achieving full output parity with the text mode.
 */
export function generateStatsJson(
  db: Database.Database,
  lastN?: number,
  verbose?: boolean,
  sinceN?: number,
  roadmapPath?: string,
  categoryFilter?: string,
): StatsJsonOutput {
  const latestCycle = getLatestCycleNumber(db);
  const effectiveLimit = computeEffectiveLimit(lastN, sinceN, categoryFilter);
  const stats = getCycleStats(db, effectiveLimit, sinceN, categoryFilter);

  // Apply same filtering logic as generateStatsTable so rows are consistent
  // with the stats aggregate.
  let rows = getCycleRows(db, effectiveLimit);
  if (sinceN !== undefined) {
    rows = rows.filter((r: CycleRow) => r.cycleNumber >= sinceN);
  }
  if (categoryFilter !== undefined) {
    rows = rows.filter((r: CycleRow) => (r.failureCategory ?? ERROR_CATEGORY_NONE) === categoryFilter);
  }

  const result: StatsJsonOutput = {
    latestCycle, window: lastN ?? null, since: sinceN ?? null, category: categoryFilter ?? null, generatedAt: new Date().toISOString(), stats, rows,
  };
  if (verbose) {
    result.learningsStaleness = getLastUpdatedCyclePerCategory(db);
    result.dangerousPatternsCount = DANGEROUS_PATTERNS.length;
    result.strategicContext = formatMemoryForPrompt(db, STATS_MEMORY_PREVIEW_CHARS) || null;
    try {
      const roadmapContent = readRoadmap(roadmapPath);
      const items = parseRoadmap(roadmapContent);
      const { rationale } = pickNextItemWithRationale(items);
      result.nextItemRationale = rationale;
    } catch (err) {
      result.nextItemRationale = `unavailable (${errorMessage(err)})`;
    }
  }
  return result;
}

/**
 * Core stats logic, accepting a db parameter for testability.
 * Returns the lines that would be printed to console.
 * @param lastN - optional override for how many recent cycles to summarise
 * @param verbose - when true, appends a "Learnings staleness" block showing
 *   the most recent cycle in which each learning category was updated
 * @param sinceN - when provided, the header notes that the view starts from
 *   cycle N; mirrors the sinceN parameter of generateStatsTable/generateStatsJson
 */
export function generateStatsOutput(db: Database.Database, lastN?: number, verbose?: boolean, sinceN?: number, roadmapPath?: string, categoryFilter?: string): string[] {
  const lines: string[] = [];

  const latestCycle = getLatestCycleNumber(db);
  if (latestCycle === 0) {
    lines.push("No evolution cycles recorded yet.");
    return lines;
  }

  const effectiveLimit = computeEffectiveLimit(lastN, sinceN, categoryFilter);
  const stats = getCycleStats(db, effectiveLimit, sinceN, categoryFilter);
  const formatted = formatCycleStats(stats);

  const windowParts: string[] = [];
  if (sinceN !== undefined) windowParts.push(`since cycle ${sinceN}`);
  if (lastN !== undefined) windowParts.push(`last ${lastN} cycles`);
  if (categoryFilter !== undefined) windowParts.push(`category: ${categoryFilter}`);
  const windowLabel = windowParts.length > 0 ? ` (${windowParts.join(", ")})` : "";

  lines.push("");
  lines.push(CYCLE_SUMMARY_SEPARATOR);
  lines.push(`  Bloom Evolution Statistics${windowLabel}`);
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

    lines.push("");
    lines.push(`Safety patterns: ${DANGEROUS_PATTERNS.length}`);

    // Show pickNextItem selection rationale so planning decisions are auditable
    try {
      const roadmapContent = readRoadmap(roadmapPath);
      const items = parseRoadmap(roadmapContent);
      const { rationale } = pickNextItemWithRationale(items);
      lines.push("");
      lines.push(STATS_NEXT_ITEM_HEADER);
      lines.push(`  ${rationale ?? STATS_NO_ACTIONABLE_ITEMS_MSG}`);
    } catch (err) {
      lines.push("");
      lines.push(`${STATS_NEXT_ITEM_HEADER} unavailable (${errorMessage(err)})`);
    }
  }

  lines.push("");

  return lines;
}

function main() {
  if (parseHelpFlag(process.argv)) {
    process.stdout.write(STATS_HELP_TEXT);
    return;
  }
  const lastN = parseLastNArg(process.argv);
  const sinceN = parseSinceArg(process.argv);
  const categoryFilter = parseCategoryArg(process.argv);
  const trendN = parseTrendArg(process.argv);
  const costAlertThreshold = parseCostAlertArg(process.argv);
  const jsonMode = parseJsonFlag(process.argv);
  const csvMode = parseCsvFlag(process.argv);
  const tableMode = parseTableFlag(process.argv);
  const verbose = parseVerboseFlag(process.argv);
  const db = initDb();
  const effectiveLimit = computeEffectiveLimit(lastN, sinceN, categoryFilter);

  let costAlertTriggered = false;
  try {
    if (trendN !== undefined) {
      console.log(generateStatsTrend(db, trendN));
    } else if (jsonMode) {
      const result = generateStatsJson(db, lastN, verbose, sinceN, undefined, categoryFilter);
      console.log(JSON.stringify(result, null, 2));
    } else if (csvMode) {
      process.stdout.write(generateStatsCsv(db, lastN, sinceN, categoryFilter));
    } else if (tableMode) {
      const table = generateStatsTable(db, lastN, verbose, sinceN, categoryFilter);
      console.log(table || "No evolution cycles recorded yet.");
    } else {
      const output = generateStatsOutput(db, lastN, verbose, sinceN, undefined, categoryFilter);
      for (const line of output) {
        console.log(line);
      }
    }

    if (costAlertThreshold !== undefined) {
      const stats = getCycleStats(db, effectiveLimit, sinceN, categoryFilter);
      const warning = checkCostAlert(stats.avgCostPerCycle, costAlertThreshold);
      if (warning !== null) {
        console.warn(warning);
        costAlertTriggered = true;
      }
    }
  } finally {
    db.close();
  }

  if (costAlertTriggered) {
    process.exit(1);
  }
}

// Only run when executed directly as a CLI script, not when imported
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  main();
}
