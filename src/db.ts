import Database from "better-sqlite3";
import type { CycleOutcome } from "./outcomes.js";
import type { PhaseUsage } from "./usage.js";
import { errorMessage } from "./errors.js";

export const DEFAULT_DB_PATH = "bloom.db";

/** Separator line used in cycle summary blocks and the stats CLI header. */
export const CYCLE_SUMMARY_SEPARATOR = "========================================";

export const CYCLE_STATS_HISTORY_LIMIT = 20;
export const RELEVANT_LEARNINGS_LIMIT = 25;
export const STRATEGIC_CONTEXT_KEEP_LAST = 20;

/**
 * Minimum relevance score below which a learning entry is pruned.
 * At the default DECAY_DEFAULT_RATE of 0.95, a learning reaches this
 * threshold after ~60 cycles, preventing unbounded table growth while
 * retaining meaningful recent knowledge.
 */
export const PRUNE_MIN_RELEVANCE = 0.05;

/** Milliseconds per minute, used for duration conversions. */
export const MS_PER_MINUTE = 60_000;

/** Token count at or above which display switches to "Nk" abbreviated form. */
export const TOKEN_DISPLAY_THRESHOLD = 1_000;

/** Number of most-recent cycles examined when computing the recent-failure count. */
export const RECENT_FAILURES_WINDOW = 5;

/** Default maximum character budget for getRecentJournalSummary output. */
export const JOURNAL_SUMMARY_MAX_CHARS = 4000;

/** Default maximum number of cycles fetched by getRecentJournalSummary. */
export const JOURNAL_SUMMARY_MAX_CYCLES = 5;

/**
 * Estimated number of journal sections written per cycle (attempted, succeeded,
 * failed, learnings, strategic_context, plus potential extras). Used by
 * exportJournalJson to compute a row-fetch limit from a cycle count.
 */
export const JOURNAL_SECTIONS_PER_CYCLE = 6;

/** Section-header strings used in journal Markdown output. */
export const JOURNAL_ATTEMPTED_HEADER = "### What was attempted";
export const JOURNAL_SUCCEEDED_HEADER = "### What succeeded";
export const JOURNAL_FAILED_HEADER = "### What failed";
export const JOURNAL_LEARNINGS_HEADER = "### Learnings";
export const JOURNAL_STRATEGIC_CONTEXT_HEADER = "### Strategic Context";

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
      failure_detail           TEXT,
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
    if (!cycleColNames.has("failure_detail")) {
      db.exec("ALTER TABLE cycles ADD COLUMN failure_detail TEXT");
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

/**
 * A lightweight per-cycle summary row used for tabular output.
 */
export interface CycleRow {
  cycleNumber: number;
  attempted: number;
  succeeded: number;
  buildPassed: boolean;
  pushed: boolean;
  durationMs: number | null;
  failureCategory: string | null;
  /** Total cost in USD for this cycle, summed from phase_usage. 0 when no usage rows exist. */
  totalCostUsd: number;
}

/**
 * Fetch the most recent `limit` cycles ordered newest-first.
 * Returns a lightweight row per cycle suitable for tabular display.
 * `totalCostUsd` is populated via a LEFT JOIN on phase_usage so each row
 * includes its cost without a separate query per cycle.
 */
export function getCycleRows(db: Database.Database, limit: number = CYCLE_STATS_HISTORY_LIMIT): CycleRow[] {
  type RawRow = {
    cycle_number: number;
    improvements_attempted: number;
    improvements_succeeded: number;
    build_verification_passed: number;
    push_succeeded: number;
    duration_ms: number | null;
    failure_category: string | null;
    total_cost: number;
  };
  const rows = validateRows<RawRow>(
    db.prepare(`
      SELECT c.cycle_number, c.improvements_attempted, c.improvements_succeeded,
             c.build_verification_passed, c.push_succeeded, c.duration_ms, c.failure_category,
             COALESCE(p.total_cost, 0) as total_cost
      FROM cycles c
      LEFT JOIN (
        SELECT cycle_number, SUM(cost_usd) as total_cost
        FROM phase_usage
        GROUP BY cycle_number
      ) p ON p.cycle_number = c.cycle_number
      ORDER BY c.cycle_number DESC
      LIMIT ?
    `).all(limit),
    {
      cycle_number: "number",
      improvements_attempted: "number",
      improvements_succeeded: "number",
      build_verification_passed: "number",
      push_succeeded: "number",
      duration_ms: "number?",
      failure_category: "string?",
      total_cost: "number",
    },
    "getCycleRows",
  );
  return rows.map(r => ({
    cycleNumber: r.cycle_number,
    attempted: r.improvements_attempted,
    succeeded: r.improvements_succeeded,
    buildPassed: r.build_verification_passed === 1,
    pushed: r.push_succeeded === 1,
    durationMs: r.duration_ms,
    failureCategory: r.failure_category,
    totalCostUsd: r.total_cost,
  }));
}

export function insertCycle(db: Database.Database, outcome: CycleOutcome): void {
  db.prepare(`
    INSERT OR REPLACE INTO cycles (
      cycle_number, started_at, preflight_passed, improvements_attempted,
      improvements_succeeded, build_verification_passed, push_succeeded,
      test_count_before, test_count_after, test_total_before, test_total_after,
      duration_ms, failure_category, failure_detail
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    outcome.failureDetail || null,
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
      failure_detail = ?,
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
    outcome.failureDetail || null,
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

export interface FailureDetail {
  cycleNumber: number;
  content: string;
}

/**
 * Fetch the most recent cycle's captured build/test failure output — the
 * `failure_detail` column, set when a cycle's build/test step broke. Used to
 * surface *what* broke into the next cycle's assessment context. Pass
 * `beforeCycle` to exclude the current in-progress cycle. Returns null when no
 * cycle has recorded a failure detail.
 */
export function getLatestFailureDetail(
  db: Database.Database,
  beforeCycle?: number,
): FailureDetail | null {
  const params: number[] = [];
  let where = "failure_detail IS NOT NULL";
  if (beforeCycle !== undefined) {
    where += " AND cycle_number < ?";
    params.push(beforeCycle);
  }
  const rows = validateRows<FailureDetail>(
    db.prepare(`
      SELECT cycle_number as cycleNumber, failure_detail as content
      FROM cycles
      WHERE ${where}
      ORDER BY cycle_number DESC
      LIMIT 1
    `).all(...params),
    { cycleNumber: "number", content: "string" },
    "getLatestFailureDetail",
  );
  return rows.length > 0 ? rows[0] : null;
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

export function getJournalEntries(db: Database.Database, limit?: number, sinceN?: number, cycleN?: number): JournalRow[] {
  const conditions: string[] = [];
  const params: (number)[] = [];
  if (cycleN !== undefined && cycleN > 0) {
    conditions.push("c.cycle_number = ?");
    params.push(cycleN);
  } else if (sinceN !== undefined && sinceN > 0) {
    conditions.push("c.cycle_number >= ?");
    params.push(sinceN);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  if (limit) params.push(limit);
  const sql = `
    SELECT c.cycle_number as cycleNumber, c.started_at as startedAt, j.section, j.content
    FROM journal_entries j
    JOIN cycles c ON c.cycle_number = j.cycle_number
    ${whereClause}
    ORDER BY c.cycle_number DESC, j.id ASC
    ${limit ? `LIMIT ?` : ""}
  `;
  const journalSchema: RowSchema = { cycleNumber: "number", startedAt: "string", section: "string", content: "string" };
  const raw = db.prepare(sql).all(...params);
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

export function exportJournalJson(db: Database.Database, maxCycles?: number, sinceN?: number, cycleN?: number): JournalExportEntry[] {
  const rowLimit = maxCycles !== undefined ? maxCycles * JOURNAL_SECTIONS_PER_CYCLE : undefined;
  const rows = getJournalEntries(db, rowLimit, sinceN, cycleN);
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
  return maxCycles !== undefined ? entries.slice(0, maxCycles) : entries;
}

/**
 * Per-phase token usage summary: input tokens, output tokens, and the
 * output-to-input ratio (outputTokens / inputTokens), useful for identifying
 * which phases are token-heavy and where prompt compression is most impactful.
 * `ratio` is null when inputTokens is 0 (division by zero guard).
 */
export interface PhaseTokenRatio {
  phase: string;
  inputTokens: number;
  outputTokens: number;
  ratio: number | null;
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
  learningCategoryDistribution: Record<string, number>;
  /** Per-phase token breakdown, ordered by total input tokens descending. Empty when no phase_usage rows exist. */
  phaseTokenRatios: PhaseTokenRatio[];
}

/**
 * Per-category staleness row: the most recent cycle number in which a learning
 * of that category was recorded. Used by `pnpm stats --verbose` to surface
 * categories that have not received new learnings recently.
 */
export interface CategoryStaleness {
  category: string;
  lastCycle: number;
}

/**
 * Return the most recent cycle number in which each learning category was updated.
 * Ordered by lastCycle descending (most recently updated first).
 * Returns an empty array when no learnings exist.
 */
export function getLastUpdatedCyclePerCategory(db: Database.Database): CategoryStaleness[] {
  return validateRows<CategoryStaleness>(
    db.prepare(
      "SELECT category, MAX(cycle_number) as lastCycle FROM learnings GROUP BY category ORDER BY lastCycle DESC",
    ).all(),
    { category: "string", lastCycle: "number" },
    "getLastUpdatedCyclePerCategory",
  );
}

/**
 * Return a count of learnings per category across all currently stored learnings.
 * Useful for identifying over- or under-represented learning types in the DB.
 */
export function getLearningCategoryDistribution(db: Database.Database): Record<string, number> {
  const rows = validateRows<{ category: string; cnt: number }>(
    db.prepare("SELECT category, COUNT(*) as cnt FROM learnings GROUP BY category").all(),
    { category: "string", cnt: "number" },
    "getLearningCategoryDistribution",
  );
  const distribution: Record<string, number> = {};
  for (const row of rows) {
    distribution[row.category] = row.cnt;
  }
  return distribution;
}

/**
 * Aggregate input/output tokens from `phase_usage` grouped by phase for the
 * given cycle numbers. Returns one entry per phase ordered by input tokens
 * descending (most token-heavy phases first).
 *
 * Extracted as a named helper so callers that already hold a cycle-number list
 * (e.g. getCycleStats) can reuse it without duplicating the SQL, mirroring the
 * pattern of getLearningCategoryDistribution.
 *
 * Returns an empty array when `cycleNumbers` is empty or no matching rows exist.
 */
export function getPhaseTokensByPhase(db: Database.Database, cycleNumbers: number[]): PhaseTokenRatio[] {
  if (cycleNumbers.length === 0) return [];
  const inPlaceholders = cycleNumbers.map(() => "?").join(",");
  const rows = validateRows<{ phase: string; total_input: number; total_output: number }>(
    db.prepare(`
      SELECT phase,
             SUM(input_tokens)  AS total_input,
             SUM(output_tokens) AS total_output
      FROM phase_usage
      WHERE cycle_number IN (${inPlaceholders})
      GROUP BY phase
      ORDER BY total_input DESC
    `).all(...cycleNumbers),
    { phase: "string", total_input: "number", total_output: "number" },
    "getPhaseTokensByPhase",
  );
  return rows.map(r => ({
    phase: r.phase,
    inputTokens: r.total_input,
    outputTokens: r.total_output,
    ratio: r.total_input > 0 ? Math.round((r.total_output / r.total_input) * 1000) / 1000 : null,
  }));
}

/**
 * Build a zero-valued CycleStats — returned when no cycles match the query.
 * Extracted so the empty-result shape lives in one place next to the interface.
 */
function emptyCycleStats(): CycleStats {
  return {
    totalCycles: 0,
    successRate: 0,
    avgImprovements: 0,
    avgConversionRate: null,
    testCountTrend: null,
    recentFailures: 0,
    avgDurationMinutes: null,
    totalCostUsd: 0,
    avgCostPerCycle: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    failureCategoryBreakdown: {},
    learningCategoryDistribution: {},
    phaseTokenRatios: [],
  };
}

/**
 * Compute aggregate success metrics over the last N cycles.
 * Answers the question: "How are you measuring success?" (community issue #3).
 * @param sinceN - when provided, only cycles with cycle_number >= sinceN are included
 * @param categoryFilter - when provided, only cycles with failure_category equal to
 *   this value are included (e.g. "build_failure", "none")
 * @param cycleN - when provided, only the exact cycle with cycle_number = cycleN is
 *   included. Takes precedence over sinceN when both are supplied.
 */
export function getCycleStats(db: Database.Database, limit: number = CYCLE_STATS_HISTORY_LIMIT, sinceN?: number, categoryFilter?: string, cycleN?: number): CycleStats {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (cycleN !== undefined) {
    conditions.push("cycle_number = ?");
    params.push(cycleN);
  } else if (sinceN !== undefined) {
    conditions.push("cycle_number >= ?");
    params.push(sinceN);
  }
  if (categoryFilter !== undefined) {
    conditions.push("failure_category = ?");
    params.push(categoryFilter);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  const rawRows: unknown[] = db.prepare(`
    SELECT
      cycle_number, preflight_passed, improvements_attempted, improvements_succeeded,
      build_verification_passed, push_succeeded,
      test_count_before, test_count_after,
      duration_ms, started_at, completed_at, failure_category
    FROM cycles ${whereClause} ORDER BY cycle_number DESC LIMIT ?
  `).all(...params);

  /** Raw snake_case row shape returned by the cycles SELECT query inside getCycleStats.
   * Named distinctly from the exported CycleRow (camelCase) to avoid scope shadowing. */
  interface RawStatsCycleRow {
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
    failure_category: string;
  }

  const cycleRowSchema: RowSchema = {
    cycle_number: "number", preflight_passed: "number", improvements_attempted: "number",
    improvements_succeeded: "number", build_verification_passed: "number",
    push_succeeded: "number", test_count_before: "number?",
    test_count_after: "number?", duration_ms: "number?",
    started_at: "string", completed_at: "string?", failure_category: "string",
  };

  const rows = validateRows<RawStatsCycleRow>(rawRows, cycleRowSchema, "getCycleStats");

  if (rows.length === 0) {
    return emptyCycleStats();
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

  // Count recent failures (last RECENT_FAILURES_WINDOW cycles)
  const recent = rows.slice(0, RECENT_FAILURES_WINDOW);
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
      avgDurationMinutes = Math.round((totalMs / count / MS_PER_MINUTE) * 10) / 10;
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

  // Failure category breakdown across all queried cycles (excluding 'none').
  // Tallied from the already-fetched rows rather than a second scan of cycles.
  const failureCategoryBreakdown: Record<string, number> = {};
  for (const r of rows) {
    if (r.failure_category !== "none") {
      failureCategoryBreakdown[r.failure_category] = (failureCategoryBreakdown[r.failure_category] ?? 0) + 1;
    }
  }

  const learningCategoryDistribution = getLearningCategoryDistribution(db);
  const phaseTokenRatios = getPhaseTokensByPhase(db, cycleNumbers);

  return { totalCycles, successRate, avgImprovements, avgConversionRate, testCountTrend, recentFailures, avgDurationMinutes, totalCostUsd, avgCostPerCycle, totalInputTokens, totalOutputTokens, failureCategoryBreakdown, learningCategoryDistribution, phaseTokenRatios };
}

/**
 * Abbreviate a token count to "Nk" form at/above TOKEN_DISPLAY_THRESHOLD,
 * otherwise render the plain integer. Shared by the cost and per-phase lines
 * of formatCycleStats.
 */
function formatTokenCount(n: number): string {
  return n >= TOKEN_DISPLAY_THRESHOLD ? `${Math.round(n / TOKEN_DISPLAY_THRESHOLD)}k` : `${n}`;
}

/**
 * Format cycle stats as a human-readable Markdown bullet list for inclusion in prompts.
 *
 * Output structure (one bullet per line):
 *   - Cycles tracked, success rate, avg improvements/cycle — always present when totalCycles > 0.
 *   - Conversion rate — only included when avgConversionRate is non-null (i.e. at least one
 *     cycle had ≥1 improvement attempt).
 *   - Test count trend — only included when testCountTrend is non-null (requires ≥1 cycle
 *     with both test_count_before and test_count_after recorded).
 *   - Avg cycle duration — only included when avgDurationMinutes is non-null.
 *   - Cost block — only included when totalCostUsd > 0 or any token count > 0. Token counts
 *     are abbreviated to "Nk" format when they reach TOKEN_DISPLAY_THRESHOLD (1 000); values
 *     below the threshold are shown as plain integers. Cost and token parts are each omitted
 *     individually when they are zero, joined by " · " when both are present.
 *   - Recent failures count — always present when totalCycles > 0.
 *   - Failure category breakdown — only included when recentFailures > 0 AND the breakdown
 *     map is non-empty; sorted by count descending then category name ascending.
 *   - Learnings by category — only included when the distribution map is non-empty;
 *     sorted by count descending then category name ascending.
 *
 * Returns "No previous cycle data available." when totalCycles === 0.
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
    const costPart = stats.totalCostUsd > 0
      ? `$${stats.totalCostUsd.toFixed(2)} total / $${stats.avgCostPerCycle.toFixed(2)} avg`
      : null;
    const tokenPart = (stats.totalInputTokens > 0 || stats.totalOutputTokens > 0)
      ? `${formatTokenCount(stats.totalInputTokens)} in / ${formatTokenCount(stats.totalOutputTokens)} out tokens`
      : null;
    const parts = [costPart, tokenPart].filter(Boolean).join(" · ");
    lines.push(`- **Cost**: ${parts}`);
  }
  lines.push(`- **Recent failures** (last ${RECENT_FAILURES_WINDOW}): ${stats.recentFailures}`);
  if (stats.recentFailures > 0 && Object.keys(stats.failureCategoryBreakdown).length > 0) {
    const breakdown = Object.entries(stats.failureCategoryBreakdown)
      .sort(([catA, cntA], [catB, cntB]) => cntB - cntA || catA.localeCompare(catB))
      .map(([cat, count]) => `${count} ${cat}`)
      .join(", ");
    lines.push(`- **Failure breakdown** (across all ${stats.totalCycles} tracked cycles): ${breakdown}`);
  }
  if (Object.keys(stats.learningCategoryDistribution).length > 0) {
    const dist = Object.entries(stats.learningCategoryDistribution)
      .sort(([catA, cntA], [catB, cntB]) => cntB - cntA || catA.localeCompare(catB))
      .map(([cat, count]) => `${count} ${cat}`)
      .join(", ");
    lines.push(`- **Learnings by category**: ${dist}`);
  }
  if (stats.phaseTokenRatios.length > 0) {
    const phaseDetails = stats.phaseTokenRatios
      .map(p => {
        const ratioStr = p.ratio !== null ? ` (ratio: ${p.ratio.toFixed(2)})` : "";
        return `${p.phase}: ${formatTokenCount(p.inputTokens)} in / ${formatTokenCount(p.outputTokens)} out${ratioStr}`;
      })
      .join(", ");
    lines.push(`- **Per-phase token efficiency**: ${phaseDetails}`);
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

/**
 * Insert a new learning entry for the given cycle.
 * Duplicate-detection is the caller's responsibility (see storeLearnings in memory.ts).
 */
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

/**
 * Retrieve the most relevant learnings, ordered by descending relevance score.
 * When `category` is supplied, only learnings in that category are returned.
 * Results are capped at `maxItems` (default: RELEVANT_LEARNINGS_LIMIT).
 */
export function getRelevantLearnings(
  db: Database.Database,
  maxItems: number = RELEVANT_LEARNINGS_LIMIT,
  category?: string,
): Learning[] {
  const learningSchema: RowSchema = { id: "number", cycleNumber: "number", category: "string", content: "string", relevance: "number" };
  const whereClause = category ? "WHERE category = ?" : "";
  const params: unknown[] = category ? [category, maxItems] : [maxItems];
  return validateRows<Learning>(
    db.prepare(
      `SELECT id, cycle_number as cycleNumber, category, content, relevance
       FROM learnings ${whereClause} ORDER BY relevance DESC, id DESC LIMIT ?`,
    ).all(...params),
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

/** Fallback decay rate applied to any learning category not listed in DECAY_BY_CATEGORY. */
export const DECAY_DEFAULT_RATE = 0.95;

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
    // Fall back to DECAY_DEFAULT_RATE for any category not listed in DECAY_BY_CATEGORY.
    const knownCategories = Object.keys(DECAY_BY_CATEGORY);
    const placeholders = knownCategories.map(() => "?").join(", ");
    db.prepare(`UPDATE learnings SET relevance = relevance * ${DECAY_DEFAULT_RATE} WHERE category NOT IN (${placeholders})`).run(...knownCategories);
  })();
}

/**
 * Amount by which a learning's relevance is boosted when the same content is
 * submitted again in a later cycle. Named constant so callers and tests can
 * reference the exact delta without encoding SQL internals.
 */
export const LEARNING_BOOST_AMOUNT = 0.1;

/**
 * Boost the relevance of an existing learning that has been seen again.
 * Resets relevance to MIN(1.0, relevance + LEARNING_BOOST_AMOUNT) so
 * frequently-reappearing patterns surface in prompts even after many cycles
 * of decay. No-op when no learning matches the given content
 * (case-insensitive trim).
 */
export function boostLearningRelevance(db: Database.Database, content: string): void {
  db.prepare(
    `UPDATE learnings SET relevance = MIN(1.0, relevance + ${LEARNING_BOOST_AMOUNT}) WHERE LOWER(TRIM(content)) = LOWER(TRIM(?))`,
  ).run(content);
}

/**
 * Remove learnings whose relevance has decayed below the given threshold.
 * Prevents unbounded table growth: after ~60 cycles at the default 0.95 decay
 * factor, relevance drops below 0.05 and the entry no longer meaningfully
 * influences prompt context.
 */
export function pruneLowRelevanceLearnings(
  db: Database.Database,
  minRelevance: number = PRUNE_MIN_RELEVANCE,
): void {
  db.prepare("DELETE FROM learnings WHERE relevance < ?").run(minRelevance);
}

// --- Strategic Context ---

/**
 * Persist the strategic context summary for a cycle.
 * Call pruneStrategicContext after insertion to bound table growth.
 */
export function insertStrategicContext(
  db: Database.Database,
  cycleNumber: number,
  summary: string,
): void {
  db.prepare(
    "INSERT INTO strategic_context (cycle_number, summary) VALUES (?, ?)",
  ).run(cycleNumber, summary);
}

/**
 * Return the most recently stored strategic context summary, or null if none exists.
 */
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

/**
 * Build a compact Markdown summary of the most recent journal cycles for
 * injection into assessment and evolution prompts.
 * Output is capped at `maxChars` characters and covers at most `maxCycles` cycles.
 * Returns an empty string on DB error (non-fatal: cycle can still proceed).
 */
export function getRecentJournalSummary(db: Database.Database, maxChars: number = JOURNAL_SUMMARY_MAX_CHARS, maxCycles: number = JOURNAL_SUMMARY_MAX_CYCLES): string {
  // A zero cycle limit means "fetch nothing" — return early to avoid the
  // falsy-zero pitfall in exportJournalJson's `maxCycles ? ... : undefined`
  // guard, which would otherwise treat 0 as "no limit" and return all rows.
  if (maxCycles === 0) return "";
  let entries: JournalExportEntry[];
  try {
    entries = exportJournalJson(db, maxCycles);
  } catch (err) {
    console.warn(`[db] getRecentJournalSummary: failed to export journal entries: ${errorMessage(err)}`);
    return "";
  }
  const lines: string[] = [];
  let totalLen = 0;

  for (const entry of entries) {
    const parts: string[] = [`## Cycle ${entry.cycleNumber} — ${entry.date}`, ""];
    if (entry.attempted) { parts.push(JOURNAL_ATTEMPTED_HEADER, entry.attempted, ""); }
    if (entry.succeeded) { parts.push(JOURNAL_SUCCEEDED_HEADER, entry.succeeded, ""); }
    if (entry.failed) { parts.push(JOURNAL_FAILED_HEADER, entry.failed, ""); }
    if (entry.learnings) { parts.push(JOURNAL_LEARNINGS_HEADER, entry.learnings, ""); }
    parts.push("---", "");
    const section = parts.join("\n");
    if (totalLen + section.length > maxChars) break;
    lines.push(section);
    totalLen += section.length;
  }

  return lines.join("\n").slice(0, maxChars);
}
