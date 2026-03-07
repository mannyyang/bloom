import Database from "better-sqlite3";
import type { CycleOutcome } from "./outcomes.js";
import type { PhaseUsage } from "./usage.js";

const DEFAULT_DB_PATH = "bloom.db";

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
      test_count_after         INTEGER
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
  `);

  return db;
}

export function getLatestCycleNumber(db: Database.Database): number {
  const row = db.prepare("SELECT MAX(cycle_number) as max_cycle FROM cycles").get() as { max_cycle: number | null } | undefined;
  return row?.max_cycle ?? 0;
}

export function insertCycle(db: Database.Database, outcome: CycleOutcome): void {
  db.prepare(`
    INSERT OR REPLACE INTO cycles (
      cycle_number, started_at, preflight_passed, improvements_attempted,
      improvements_succeeded, build_verification_passed, push_succeeded,
      test_count_before, test_count_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      test_count_after = ?
    WHERE cycle_number = ?
  `).run(
    outcome.preflightPassed ? 1 : 0,
    outcome.improvementsAttempted,
    outcome.improvementsSucceeded,
    outcome.buildVerificationPassed ? 1 : 0,
    outcome.pushSucceeded ? 1 : 0,
    outcome.testCountBefore,
    outcome.testCountAfter,
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
    "INSERT INTO issue_actions (cycle_number, issue_number, action) VALUES (?, ?, ?)",
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
  return limit
    ? (db.prepare(sql).all(limit) as JournalRow[])
    : (db.prepare(sql).all() as JournalRow[]);
}

export interface JournalExportEntry {
  cycleNumber: number;
  date: string;
  attempted: string;
  succeeded: string;
  failed: string;
  learnings: string;
}

export function exportJournalJson(db: Database.Database): JournalExportEntry[] {
  const rows = getJournalEntries(db);
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
    });
  }

  return entries.sort((a, b) => b.cycleNumber - a.cycleNumber);
}

export interface CycleStats {
  totalCycles: number;
  successRate: number;
  avgImprovements: number;
  testCountTrend: number | null;
  recentFailures: number;
}

/**
 * Compute aggregate success metrics over the last N cycles.
 * Answers the question: "How are you measuring success?" (community issue #3).
 */
export function getCycleStats(db: Database.Database, limit: number = 20): CycleStats {
  const rows = db.prepare(`
    SELECT
      preflight_passed, improvements_attempted, improvements_succeeded,
      build_verification_passed, push_succeeded,
      test_count_before, test_count_after
    FROM cycles ORDER BY cycle_number DESC LIMIT ?
  `).all(limit) as {
    preflight_passed: number;
    improvements_attempted: number;
    improvements_succeeded: number;
    build_verification_passed: number;
    push_succeeded: number;
    test_count_before: number | null;
    test_count_after: number | null;
  }[];

  if (rows.length === 0) {
    return { totalCycles: 0, successRate: 0, avgImprovements: 0, testCountTrend: null, recentFailures: 0 };
  }

  const totalCycles = rows.length;
  const successfulCycles = rows.filter(r => r.build_verification_passed === 1 && r.push_succeeded === 1).length;
  const successRate = Math.round((successfulCycles / totalCycles) * 100);

  const totalImprovements = rows.reduce((sum, r) => sum + r.improvements_succeeded, 0);
  const avgImprovements = Math.round((totalImprovements / totalCycles) * 10) / 10;

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

  return { totalCycles, successRate, avgImprovements, testCountTrend, recentFailures };
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
  if (stats.testCountTrend !== null) {
    const sign = stats.testCountTrend >= 0 ? "+" : "";
    lines.push(`- **Test count trend**: ${sign}${stats.testCountTrend}`);
  }
  lines.push(`- **Recent failures** (last 5): ${stats.recentFailures}`);
  return lines.join("\n");
}

export function getRecentJournalSummary(db: Database.Database, maxChars: number = 4000): string {
  const entries = exportJournalJson(db).slice(0, 10);
  const lines: string[] = [];
  let totalLen = 0;

  for (const entry of entries) {
    const section = `## Cycle ${entry.cycleNumber} — ${entry.date}\n\n### What was attempted\n${entry.attempted}\n\n### What succeeded\n${entry.succeeded}\n\n### What failed\n${entry.failed}\n\n### Learnings\n${entry.learnings}\n\n---\n`;
    if (totalLen + section.length > maxChars && lines.length > 0) break;
    lines.push(section);
    totalLen += section.length;
  }

  return lines.join("\n");
}
