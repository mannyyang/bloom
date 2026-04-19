import Database from "better-sqlite3";
import type { CycleOutcome } from "./outcomes.js";
import type { PhaseUsage } from "./usage.js";

const DEFAULT_DB_PATH = "bloom.db";

export const CYCLE_STATS_HISTORY_LIMIT = 20;
export const RELEVANT_LEARNINGS_LIMIT = 20;
export const STRATEGIC_CONTEXT_KEEP_LAST = 20;

// --- Row validation helpers ---

type FieldType = "number" | "number?" | "string" | "string?";
type RowSchema = Record<string, FieldType>;

function checkField(row: Record<string, unknown>, key: string, spec: FieldType, label: string): void {
  const val = row[key];
  switch (spec) {
    case "number":
      if (typeof val !== "number") throw new Error(`${label}: expected "${key}" to be number, got ${typeof val}`);
      break;
    case "number?":
      if (val !== null && typeof val !== "number") throw new Error(`${label}: expected "${key}" to be number|null, got ${typeof val}`);
      break;
    case "string":
      if (typeof val !== "string") throw new Error(`${label}: expected "${key}" to be string, got ${typeof val}`);
      break;
    case "string?":
      if (val !== null && typeof val !== "string") throw new Error(`${label}: expected "${key}" to be string|null, got ${typeof val}`);
      break;
    default:
      throw new Error(`${label}: unknown field spec "${spec}" for key "${key}"`);
  }
}

/**
 * Validate that a single row (from `.get()`) matches the expected schema.
 * Returns the row cast to T, or undefined if the input is undefined.
 * Throws a descriptive error if any field has the wrong type.
 */
export function validateOptionalRow<T>(row: unknown, schema: RowSchema, label: string): T | undefined {
  if (row === undefined) return undefined;
  if (row === null || typeof row !== "object") {
    throw new Error(`${label}: expected row object, got ${typeof row}`);
  }
  const obj = row as Record<string, unknown>;
  for (const [key, spec] of Object.entries(schema)) {
    checkField(obj, key, spec, label);
  }
  return row as T;
}

/**
 * Validate that a single row matches the expected schema. Throws if undefined.
 */
export function validateRow<T>(row: unknown, schema: RowSchema, label: string): T {
  const result = validateOptionalRow<T>(row, schema, label);
  if (result === undefined) {
    throw new Error(`${label}: expected a row but got undefined`);
  }
  return result;
}

/**
 * Validate that all rows in an array match the expected schema.
 */
export function validateRows<T>(rows: unknown[], schema: RowSchema, label: string): T[] {
  return rows.map((row, i) => validateRow<T>(row, schema, `${label}[${i}]`));
}

export function initDb(path: string = DEFAULT_DB_PATH): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS cycles (
      cycle_number INTEGER PRIMARY KEY,
      started_at   TEXT NOT NULL,
      preflight_passed         INTEGER NOT NULL DEFAULT 0,
      improvements_attempted   INTEGER NOT NULL DEFAULT 0,
      improvements_succeeded   INTEGER NOT NULL DEFAULT 0,
      build_verification_passed INTEGER NOT NULL DEFAULT 0,
      push_succeeded           INTEGER NOT NULL DEFAULT 0,
      test_count_before        INTEGER,
      test_count_after         INTEGER,
      test_total_before        INTEGER,
      test_total_after         INTEGER,
      duration_ms              INTEGER,
      failure_category         TEXT NOT NULL DEFAULT 'none',
      completed_at             TEXT
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_number INTEGER NOT NULL REFERENCES cycles(cycle_number),
      section      TEXT NOT NULL,
      content      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS phase_usage (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_number INTEGER NOT NULL REFERENCES cycles(cycle_number),
      phase        TEXT NOT NULL,
      cost_usd     REAL NOT NULL DEFAULT 0,
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      num_turns    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS issue_actions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_number INTEGER NOT NULL REFERENCES cycles(cycle_number),
      issue_number INTEGER NOT NULL,
      action       TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_actions_unique
      ON issue_actions(issue_number, action);

    CREATE TABLE IF NOT EXISTS learnings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_number INTEGER NOT NULL REFERENCES cycles(cycle_number),
      category     TEXT NOT NULL,
      content      TEXT NOT NULL,
      relevance    REAL NOT NULL DEFAULT 1.0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
    CREATE INDEX IF NOT EXISTS idx_learnings_relevance ON learnings(relevance DESC);

    CREATE INDEX IF NOT EXISTS idx_journal_entries_cycle ON journal_entries(cycle_number);
    CREATE INDEX IF NOT EXISTS idx_phase_usage_cycle ON phase_usage(cycle_number);

    CREATE TABLE IF NOT EXISTS strategic_context (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_number INTEGER NOT NULL REFERENCES cycles(cycle_number),
      summary      TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // --- Migrations: add columns that may be missing from older databases ---
  // Wrapped in a transaction so a mid-migration crash (disk full, OOM) leaves
  // the schema fully unchanged rather than partially upgraded. SQLite supports
  // DDL statements inside transactions, so a BEGIN/COMMIT wraps all ALTER TABLE
  // calls atomically — either all columns are added or none are.
  db.transaction(() => {
    const cycleColumns = validateRows<{ name: string }>(
      db.prepare("PRAGMA table_info(cycles)").all(),
      { name: "string" },
      "PRAGMA.table_info(cycles)",
    );
    const cycleColNames = new Set(cycleColumns.map(c => c.name));

    if (!cycleColNames.has("duration_ms")) {
      db.exec("ALTER TABLE cycles ADD COLUMN duration_ms INTEGER");
    }
    if (!cycleColNames.has("completed_at")) {
      db.exec("ALTER TABLE cycles ADD COLUMN completed_at TEXT");
    }
    if (!cycleColNames.has("test_total_before")) {
      db.exec("ALTER TABLE cycles ADD COLUMN test_total_before INTEGER");
    }
    if (!cycleColNames.has("test_total_after")) {
      db.exec("ALTER TABLE cycles ADD COLUMN test_total_after INTEGER");
    }
    if (!cycleColNames.has("failure_category")) {
      db.exec("ALTER TABLE cycles ADD COLUMN failure_category TEXT NOT NULL DEFAULT 'none'");
    }
  })();

  return db;
}

export function getLatestCycleNumber(db: Database.Database): number {
  const row = validateOptionalRow<{ max_cycle: number | null }>(
    db.prepare("SELECT MAX(cycle_number) as max_cycle FROM cycles").get(),
    { max_cycle: "number?" },
    "getLatestCycleNumber",
  );
  return row?.max_cycle ?? 0;
}

export function insertCycle(db: Database.Database, outcome: CycleOutcome): void {
  db.prepare(`
    INSERT OR REPLACE INTO cycles (
      cycle_number, started_at, preflight_passed, improvements_attempted,
      improvements_succeeded, build_verification_passed, push_succeeded,
      test_count_before, test_count_after, test_total_before, test_total_after,
      duration_ms, failure_category
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    outcome.cycleNumber,
    new Date().toISOString(),
    outcome.preflightPassed ? 1 : 0,
    outcome.improvementsAttempted,
    outcome.improvementsSucceeded,
    outcome.buildVerificationPassed ? 1 : 0,
    outcome.pushSucceeded ? 1 : 0,
    outcome.testCountBefore,
    outcome.testCountAfter,
    outcome.testTotalBefore,
    outcome.testTotalAfter,
    outcome.durationMs,
    outcome.failureCategory,
  );
}

/**
 * Update an existing cycle row with final outcome metrics.
 * Preserves the original `started_at` timestamp.
 */
export function updateCycleOutcome(db: Database.Database, outcome: CycleOutcome): void {
  db.prepare(`
    UPDATE cycles SET
      preflight_passed = ?,
      improvements_attempted = ?,
      improvements_succeeded = ?,
      build_verification_passed = ?,
      push_succeeded = ?,
      test_count_before = ?,
      test_count_after = ?,
      test_total_before = ?,
      test_total_after = ?,
      duration_ms = ?,
      failure_category = ?,
      completed_at = ?
    WHERE cycle_number = ?
  `).run(
    outcome.preflightPassed ? 1 : 0,
    outcome.improvementsAttempted,
    outcome.improvementsSucceeded,
    outcome.buildVerificationPassed ? 1 : 0,
    outcome.pushSucceeded ? 1 : 0,
    outcome.testCountBefore,
    outcome.testCountAfter,
    outcome.testTotalBefore,
    outcome.testTotalAfter,
    outcome.durationMs,
    outcome.failureCategory,
    new Date().toISOString(),
    outcome.cycleNumber,
  );
}

export function insertJournalEntry(
  db: Database.Database,
  cycleNumber: number,
  section: string,
  content: string,
): void {
  db.prepare(
    "INSERT INTO journal_entries (cycle_number, section, content) VALUES (?, ?, ?)",
  ).run(cycleNumber, section, content);
}

export function insertPhaseUsage(
  db: Database.Database,
  cycleNumber: number,
  usage: PhaseUsage,
): void {
  db.prepare(`
    INSERT INTO phase_usage (
      cycle_number, phase, cost_usd, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, duration_ms, num_turns
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cycleNumber,
    usage.phase,
    usage.totalCostUsd,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadInputTokens,
    usage.cacheCreationInputTokens,
    usage.durationMs,
    usage.numTurns,
  );
}

export function insertIssueAction(
  db: Database.Database,
  cycleNumber: number,
  issueNumber: number,
  action: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO issue_actions (cycle_number, issue_number, action) VALUES (?, ?, ?)",
  ).run(cycleNumber, issueNumber, action);
}

/**
 * Check whether a specific action has already been recorded for an issue.
 * Useful for making acknowledge/close operations idempotent across cycles.
 */
export function hasIssueAction(
  db: Database.Database,
  issueNumber: number,
  action: string,
): boolean {
  const row = db.prepare(
    "SELECT 1 FROM issue_actions WHERE issue_number = ? AND action = ? LIMIT 1",
  ).get(issueNumber, action);
  return row !== undefined;
}

export interface JournalRow {
  cycleNumber: number;
  startedAt: string;
  section: string;
  content: string;
}

export function getJournalEntries(db: Database.Database, limit?: number): JournalRow[] {
  const sql = `
    SELECT c.cycle_number as cycleNumber, c.started_at as startedAt, j.section, j.content
    FROM journal_entries j
    JOIN cycles c ON c.cycle_number = j.cycle_number
    ORDER BY c.cycle_number DESC, j.id ASC
    ${limit ? `LIMIT ?` : ""}
  `;
  const journalSchema: RowSchema = { cycleNumber: "number", startedAt: "string", section: "string", content: "string" };
  const raw = limit ? db.prepare(sql).all(limit) : db.prepare(sql).all();
  return validateRows<JournalRow>(raw, journalSchema, "getJournalEntries");
}

export interface JournalExportEntry {
  cycleNumber: number;
  date: string;
  attempted: string;
  succeeded: string;
  failed: string;
  learnings: string;
  strategic_context: string;
}

export function exportJournalJson(db: Database.Database, maxCycles?: number): JournalExportEntry[] {
  // Estimate row limit: each cycle has at most 6 sections (attempted, succeeded,
  // failed, learnings, strategic_context, plus potential extras). Fetch a few
  // extra rows to account for cycles with fewer sections.
  const rowLimit = maxCycles ? maxCycles * 6 : undefined;
  const rows = getJournalEntries(db, rowLimit);
  const grouped = new Map<number, { date: string; sections: Map<string, string> }>();

  for (const row of rows) {
    if (!grouped.has(row.cycleNumber)) {
      grouped.set(row.cycleNumber, {
        date: row.startedAt.split("T")[0],
        sections: new Map(),
      });
    }
    grouped.get(row.cycleNumber)!.sections.set(row.section, row.content);
  }

  const entries: JournalExportEntry[] = [];
  for (const [cycleNumber, data] of grouped) {
    entries.push({
      cycleNumber,
      date: data.date,
      attempted: data.sections.get("attempted") ?? "",
      succeeded: data.sections.get("succeeded") ?? "",
      failed: data.sections.get("failed") ?? "",
      learnings: data.sections.get("learnings") ?? "",
      strategic_context: data.sections.get("strategic_context") ?? "",
    });
  }

  // entries are already in descending cycle order from getJournalEntries (ORDER BY DESC)
  return maxCycles ? entries.slice(0, maxCycles) : entries;
}

export interface CycleStats {
  totalCycles: number;
  successRate: number;
  avgImprovements: number;
  avgConversionRate: number | null;
  testCountTrend: number | null;
  recentFailures: number;
  avgDurationMinutes: number | null;
  totalCostUsd: number;
  avgCostPerCycle: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  failureCategoryBreakdown: Record<string, number>;
}

/**
 * Compute aggregate success metrics over the last N cycles.
 * Answers the question: "How are you measuring success?" (community issue #3).
 */
export function getCycleStats(db: Database.Database, limit: number = CYCLE_STATS_HISTORY_LIMIT): CycleStats {
  const rawRows = db.prepare(`
    SELECT
      cycle_number, preflight_passed, improvements_attempted, improvements_succeeded,
      build_verification_passed, push_succeeded,
      test_count_before, test_count_after,
      duration_ms, started_at, completed_at
    FROM cycles ORDER BY cycle_number DESC LIMIT ?
  `).all(limit);

  interface CycleRow {
    cycle_number: number;
    preflight_passed: number;
    improvements_attempted: number;
    improvements_succeeded: number;
    build_verification_passed: number;
    push_succeeded: number;
    test_count_before: number | null;
    test_count_after: number | null;
    duration_ms: number | null;
    started_at: string;
    completed_at: string | null;
  }

  const cycleRowSchema: RowSchema = {
    cycle_number: "number", preflight_passed: "number", improvements_attempted: "number",
    improvements_succeeded: "number", build_verification_passed: "number",
    push_succeeded: "number", test_count_before: "number?",
    test_count_after: "number?", duration_ms: "number?",
    started_at: "string", completed_at: "string?",
  };

  const rows = validateRows<CycleRow>(rawRows, cycleRowSchema, "getCycleStats");

  if (rows.length === 0) {
    return { totalCycles: 0, successRate: 0, avgImprovements: 0, avgConversionRate: null, testCountTrend: null, recentFailures: 0, avgDurationMinutes: null, totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 0, totalOutputTokens: 0, failureCategoryBreakdown: {} };
  }

  const totalCycles = rows.length;
  const successfulCycles = rows.filter(r => r.build_verification_passed === 1 && r.push_succeeded === 1).length;
  const successRate = Math.round((successfulCycles / totalCycles) * 100);

  const totalImprovements = rows.reduce((sum, r) => sum + r.improvements_succeeded, 0);
  const avgImprovements = Math.round((totalImprovements / totalCycles) * 10) / 10;

  // Conversion rate: improvements_succeeded / improvements_attempted across cycles with ≥1 attempt
  const cyclesWithAttempts = rows.filter(r => r.improvements_attempted > 0);
  let avgConversionRate: number | null = null;
  if (cyclesWithAttempts.length > 0) {
    const totalAttempted = cyclesWithAttempts.reduce((sum, r) => sum + r.improvements_attempted, 0);
    const totalSucceeded = cyclesWithAttempts.reduce((sum, r) => sum + r.improvements_succeeded, 0);
    avgConversionRate = Math.round((totalSucceeded / totalAttempted) * 100);
  }

  // Test count trend: difference between newest and oldest cycle that have both counts
  const withCounts = rows.filter(r => r.test_count_before !== null && r.test_count_after !== null);
  let testCountTrend: number | null = null;
  if (withCounts.length >= 2) {
    const newest = withCounts[0];
    const oldest = withCounts[withCounts.length - 1];
    testCountTrend = (newest.test_count_after ?? 0) - (oldest.test_count_before ?? 0);
  } else if (withCounts.length === 1) {
    testCountTrend = (withCounts[0].test_count_after ?? 0) - (withCounts[0].test_count_before ?? 0);
  }

  // Count recent failures (last 5 cycles)
  const recent = rows.slice(0, 5);
  const recentFailures = recent.filter(r => r.build_verification_passed !== 1 || r.push_succeeded !== 1).length;

  // Average cycle duration — prefer precise duration_ms, fall back to timestamp subtraction
  let avgDurationMinutes: number | null = null;
  {
    let totalMs = 0;
    let count = 0;
    for (const r of rows) {
      if (r.duration_ms !== null) {
        totalMs += r.duration_ms;
        count++;
      } else if (r.started_at && r.completed_at) {
        const diff = new Date(r.completed_at).getTime() - new Date(r.started_at).getTime();
        if (!isNaN(diff)) {
          totalMs += diff;
          count++;
        }
      }
    }
    if (count > 0) {
      avgDurationMinutes = Math.round((totalMs / count / 60000) * 10) / 10;
    }
  }

  // Build an IN-list from the already-fetched cycle numbers — avoids two redundant subqueries
  const cycleNumbers = rows.map(r => r.cycle_number);
  const inPlaceholders = cycleNumbers.map(() => "?").join(",");

  // Aggregate cost and token usage from phase_usage for the cycles in scope
  // rows.length > 0 is guaranteed here (early return above handles empty case)
  const usageRow = validateRow<{ total_cost: number; total_input: number; total_output: number }>(
    db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) as total_cost, COALESCE(SUM(input_tokens), 0) as total_input, COALESCE(SUM(output_tokens), 0) as total_output FROM phase_usage WHERE cycle_number IN (${inPlaceholders})`
    ).get(...cycleNumbers),
    { total_cost: "number", total_input: "number", total_output: "number" },
    "getCycleStats.usage",
  );
  const totalCostUsd = Math.round(usageRow.total_cost * 100) / 100;
  const avgCostPerCycle = totalCycles > 0 ? Math.round((totalCostUsd / totalCycles) * 100) / 100 : 0;
  const totalInputTokens = usageRow.total_input;
  const totalOutputTokens = usageRow.total_output;

  // Failure category breakdown across all queried cycles (excluding 'none')
  const failureCategoryRaw = validateRows<{ failure_category: string; cnt: number }>(
    db.prepare(`
      SELECT failure_category, COUNT(*) as cnt
      FROM cycles
      WHERE cycle_number IN (${inPlaceholders})
        AND failure_category != 'none'
      GROUP BY failure_category
    `).all(...cycleNumbers),
    { failure_category: "string", cnt: "number" },
    "getCycleStats.failureCategory",
  );
  const failureCategoryBreakdown: Record<string, number> = {};
  for (const row of failureCategoryRaw) {
    failureCategoryBreakdown[row.failure_category] = row.cnt;
  }

  return { totalCycles, successRate, avgImprovements, avgConversionRate, testCountTrend, recentFailures, avgDurationMinutes, totalCostUsd, avgCostPerCycle, totalInputTokens, totalOutputTokens, failureCategoryBreakdown };
}

/**
 * Format cycle stats as a human-readable string for inclusion in prompts.
 */
export function formatCycleStats(stats: CycleStats): string {
  if (stats.totalCycles === 0) return "No previous cycle data available.";
  const lines = [
    `- **Cycles tracked**: ${stats.totalCycles}`,
    `- **Success rate**: ${stats.successRate}% (build passed + pushed)`,
    `- **Avg improvements/cycle**: ${stats.avgImprovements}`,
  ];
  if (stats.avgConversionRate !== null) {
    lines.push(`- **Conversion rate**: ${stats.avgConversionRate}% (improvements that succeed)`);
  }
  if (stats.testCountTrend !== null) {
    const sign = stats.testCountTrend >= 0 ? "+" : "";
    lines.push(`- **Test count trend**: ${sign}${stats.testCountTrend}`);
  }
  if (stats.avgDurationMinutes !== null) {
    lines.push(`- **Avg cycle duration**: ${stats.avgDurationMinutes} min`);
  }
  if (stats.totalCostUsd > 0 || stats.totalInputTokens > 0 || stats.totalOutputTokens > 0) {
    const fmtTokens = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
    const costPart = stats.totalCostUsd > 0
      ? `$${stats.totalCostUsd.toFixed(2)} total / $${stats.avgCostPerCycle.toFixed(2)} avg`
      : null;
    const tokenPart = (stats.totalInputTokens > 0 || stats.totalOutputTokens > 0)
      ? `${fmtTokens(stats.totalInputTokens)} in / ${fmtTokens(stats.totalOutputTokens)} out tokens`
      : null;
    const parts = [costPart, tokenPart].filter(Boolean).join(" · ");
    lines.push(`- **Cost**: ${parts}`);
  }
  lines.push(`- **Recent failures** (last 5): ${stats.recentFailures}`);
  if (stats.recentFailures > 0 && Object.keys(stats.failureCategoryBreakdown).length > 0) {
    const breakdown = Object.entries(stats.failureCategoryBreakdown)
      .map(([cat, count]) => `${count} ${cat}`)
      .join(", ");
    lines.push(`- **Failure breakdown** (across last ${stats.totalCycles} cycles): ${breakdown}`);
  }
  return lines.join("\n");
}

// --- Learnings ---

export interface Learning {
  id: number;
  cycleNumber: number;
  category: string;
  content: string;
  relevance: number;
}

export function insertLearning(
  db: Database.Database,
  cycleNumber: number,
  category: string,
  content: string,
): void {
  db.prepare(
    "INSERT INTO learnings (cycle_number, category, content) VALUES (?, ?, ?)",
  ).run(cycleNumber, category, content);
}

export function getRelevantLearnings(
  db: Database.Database,
  maxItems: number = RELEVANT_LEARNINGS_LIMIT,
  category?: string,
): Learning[] {
  const learningSchema: RowSchema = { id: "number", cycleNumber: "number", category: "string", content: "string", relevance: "number" };
  if (category) {
    return validateRows<Learning>(
      db.prepare(
        `SELECT id, cycle_number as cycleNumber, category, content, relevance
         FROM learnings WHERE category = ? ORDER BY relevance DESC, id DESC LIMIT ?`,
      ).all(category, maxItems),
      learningSchema,
      "getRelevantLearnings",
    );
  }
  return validateRows<Learning>(
    db.prepare(
      `SELECT id, cycle_number as cycleNumber, category, content, relevance
       FROM learnings ORDER BY relevance DESC, id DESC LIMIT ?`,
    ).all(maxItems),
    learningSchema,
    "getRelevantLearnings",
  );
}

/**
 * Per-category decay rates applied when decayLearningRelevance() is called
 * without an explicit decayFactor. Architectural learnings (pattern,
 * anti-pattern) persist longer; operational ones (process, tool-usage) decay
 * faster since they go stale more quickly.
 */
export const DECAY_BY_CATEGORY: Record<string, number> = {
  "pattern": 0.98,
  "anti-pattern": 0.97,
  "domain": 0.95,
  "process": 0.93,
  "tool-usage": 0.93,
};

export function decayLearningRelevance(
  db: Database.Database,
  decayFactor?: number,
): void {
  if (decayFactor !== undefined) {
    // Uniform decay — used by tests and callers that supply an explicit factor.
    db.prepare("UPDATE learnings SET relevance = relevance * ?").run(decayFactor);
    return;
  }
  // Per-category weighted decay: architectural insights persist longer than
  // operational learnings that go stale faster. Wrapped in a transaction so
  // a mid-loop crash cannot leave some categories decayed and others not —
  // either all categories decay atomically or none do.
  db.transaction(() => {
    for (const [category, rate] of Object.entries(DECAY_BY_CATEGORY)) {
      db.prepare("UPDATE learnings SET relevance = relevance * ? WHERE category = ?").run(rate, category);
    }
    // Fall back to 0.95 for any category not listed in DECAY_BY_CATEGORY.
    const knownCategories = Object.keys(DECAY_BY_CATEGORY);
    const placeholders = knownCategories.map(() => "?").join(", ");
    db.prepare(`UPDATE learnings SET relevance = relevance * 0.95 WHERE category NOT IN (${placeholders})`).run(...knownCategories);
  })();
}

/**
 * Remove learnings whose relevance has decayed below the given threshold.
 * Prevents unbounded table growth: after ~60 cycles at the default 0.95 decay
 * factor, relevance drops below 0.05 and the entry no longer meaningfully
 * influences prompt context.
 */
export function pruneLowRelevanceLearnings(
  db: Database.Database,
  minRelevance: number = 0.05,
): void {
  db.prepare("DELETE FROM learnings WHERE relevance < ?").run(minRelevance);
}

// --- Strategic Context ---

export function insertStrategicContext(
  db: Database.Database,
  cycleNumber: number,
  summary: string,
): void {
  db.prepare(
    "INSERT INTO strategic_context (cycle_number, summary) VALUES (?, ?)",
  ).run(cycleNumber, summary);
}

export function getLatestStrategicContext(
  db: Database.Database,
): string | null {
  const row = validateOptionalRow<{ summary: string }>(
    db.prepare("SELECT summary FROM strategic_context ORDER BY id DESC LIMIT 1").get(),
    { summary: "string" },
    "getLatestStrategicContext",
  );
  return row?.summary ?? null;
}

/**
 * Prune old strategic context rows, keeping only the most recent `keepLast` entries.
 * Prevents unbounded growth of the strategic_context table over many cycles.
 */
export function pruneStrategicContext(
  db: Database.Database,
  keepLast: number = STRATEGIC_CONTEXT_KEEP_LAST,
): void {
  db.prepare(`
    DELETE FROM strategic_context
    WHERE id NOT IN (
      SELECT id FROM strategic_context ORDER BY id DESC LIMIT ?
    )
  `).run(keepLast);
}

export function getRecentJournalSummary(db: Database.Database, maxChars: number = 4000, maxCycles: number = 5): string {
  const entries = exportJournalJson(db, maxCycles);
  const lines: string[] = [];
  let totalLen = 0;

  for (const entry of entries) {
    const parts: string[] = [`## Cycle ${entry.cycleNumber} — ${entry.date}`, ""];
    if (entry.attempted) { parts.push("### What was attempted", entry.attempted, ""); }
    if (entry.succeeded) { parts.push("### What succeeded", entry.succeeded, ""); }
    if (entry.failed) { parts.push("### What failed", entry.failed, ""); }
    if (entry.learnings) { parts.push("### Learnings", entry.learnings, ""); }
    parts.push("---", "");
    const section = parts.join("\n");
    if (totalLen + section.length > maxChars && lines.length > 0) break;
    lines.push(section);
    totalLen += section.length;
  }

  return lines.join("\n");
}
