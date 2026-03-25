import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import {
  initDb,
  getLatestCycleNumber,
  insertCycle,
  updateCycleOutcome,
  insertJournalEntry,
  insertPhaseUsage,
  insertIssueAction,
  hasIssueAction,
  getJournalEntries,
  exportJournalJson,
  getRecentJournalSummary,
  getCycleStats,
  formatCycleStats,
  validateRow,
  validateOptionalRow,
  validateRows,
} from "../src/db.js";
import Database from "better-sqlite3";
import { makeOutcome } from "./helpers.js";

describe("db", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  describe("initDb", () => {
    it("creates all tables", () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all() as { name: string }[];
      const names = tables.map(t => t.name);
      expect(names).toContain("cycles");
      expect(names).toContain("journal_entries");
      expect(names).toContain("phase_usage");
      expect(names).toContain("issue_actions");
    });

    describe("migrations — legacy schema missing columns", () => {
      // Creates a file-backed DB with only the original columns (no completed_at,
      // test_total_before, test_total_after) and verifies initDb adds them.
      function createLegacyDb(path: string): void {
        const legacy = new Database(path);
        legacy.exec(`
          CREATE TABLE cycles (
            cycle_number INTEGER PRIMARY KEY,
            started_at TEXT NOT NULL,
            preflight_passed INTEGER NOT NULL DEFAULT 0,
            improvements_attempted INTEGER NOT NULL DEFAULT 0,
            improvements_succeeded INTEGER NOT NULL DEFAULT 0,
            build_verification_passed INTEGER NOT NULL DEFAULT 0,
            push_succeeded INTEGER NOT NULL DEFAULT 0,
            test_count_before INTEGER,
            test_count_after INTEGER
          )
        `);
        legacy.close();
      }

      it("adds completed_at column when missing", () => {
        const path = join(tmpdir(), `bloom-migration-test-${Date.now()}-a.db`);
        createLegacyDb(path);
        const migratedDb = initDb(path);
        const cols = migratedDb.prepare("PRAGMA table_info(cycles)").all() as { name: string }[];
        const colNames = new Set(cols.map(c => c.name));
        expect(colNames.has("completed_at")).toBe(true);
        migratedDb.close();
        unlinkSync(path);
      });

      it("adds test_total_before column when missing", () => {
        const path = join(tmpdir(), `bloom-migration-test-${Date.now()}-b.db`);
        createLegacyDb(path);
        const migratedDb = initDb(path);
        const cols = migratedDb.prepare("PRAGMA table_info(cycles)").all() as { name: string }[];
        const colNames = new Set(cols.map(c => c.name));
        expect(colNames.has("test_total_before")).toBe(true);
        migratedDb.close();
        unlinkSync(path);
      });

      it("adds test_total_after column when missing", () => {
        const path = join(tmpdir(), `bloom-migration-test-${Date.now()}-c.db`);
        createLegacyDb(path);
        const migratedDb = initDb(path);
        const cols = migratedDb.prepare("PRAGMA table_info(cycles)").all() as { name: string }[];
        const colNames = new Set(cols.map(c => c.name));
        expect(colNames.has("test_total_after")).toBe(true);
        migratedDb.close();
        unlinkSync(path);
      });

      it("adds duration_ms column when missing", () => {
        const path = join(tmpdir(), `bloom-migration-test-${Date.now()}-d.db`);
        createLegacyDb(path);
        const migratedDb = initDb(path);
        const cols = migratedDb.prepare("PRAGMA table_info(cycles)").all() as { name: string }[];
        const colNames = new Set(cols.map(c => c.name));
        expect(colNames.has("duration_ms")).toBe(true);
        migratedDb.close();
        unlinkSync(path);
      });

      it("adds failure_category column when missing", () => {
        const path = join(tmpdir(), `bloom-migration-test-${Date.now()}-e.db`);
        createLegacyDb(path);
        const migratedDb = initDb(path);
        const cols = migratedDb.prepare("PRAGMA table_info(cycles)").all() as { name: string }[];
        const colNames = new Set(cols.map(c => c.name));
        expect(colNames.has("failure_category")).toBe(true);
        migratedDb.close();
        unlinkSync(path);
      });
    });
  });

  describe("getLatestCycleNumber", () => {
    it("returns 0 when no cycles exist", () => {
      expect(getLatestCycleNumber(db)).toBe(0);
    });

    it("returns the highest cycle number", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 5 }));
      insertCycle(db, makeOutcome({ cycleNumber: 10 }));
      expect(getLatestCycleNumber(db)).toBe(10);
    });
  });

  describe("insertCycle + insertJournalEntry", () => {
    it("inserts and retrieves journal entries", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 2, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
        testCountBefore: 100, testCountAfter: 105,
      }));
      insertJournalEntry(db, 1, "attempted", "Tried two things");
      insertJournalEntry(db, 1, "succeeded", "One worked");
      insertJournalEntry(db, 1, "failed", "One didn't");
      insertJournalEntry(db, 1, "learnings", "Learned stuff");

      const entries = getJournalEntries(db);
      expect(entries).toHaveLength(4);
      expect(entries[0].section).toBe("attempted");
      expect(entries[0].content).toBe("Tried two things");
    });

    it("respects the limit parameter", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
        testCountBefore: 10, testCountAfter: 12,
      }));
      insertCycle(db, makeOutcome({
        cycleNumber: 2, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
        testCountBefore: 12, testCountAfter: 15,
      }));
      insertJournalEntry(db, 1, "attempted", "Cycle 1 attempt");
      insertJournalEntry(db, 1, "succeeded", "Cycle 1 success");
      insertJournalEntry(db, 2, "attempted", "Cycle 2 attempt");
      insertJournalEntry(db, 2, "succeeded", "Cycle 2 success");

      const limited = getJournalEntries(db, 2);
      expect(limited).toHaveLength(2);
      // ORDER BY cycle_number DESC, so cycle 2 entries come first
      expect(limited[0].cycleNumber).toBe(2);

      // Without limit, all 4 entries are returned
      const all = getJournalEntries(db);
      expect(all).toHaveLength(4);
    });

    it("directly persists failureCategory in the inserted row", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, buildVerificationPassed: false, pushSucceeded: false,
        failureCategory: "build_failure",
      }));

      const row = db.prepare("SELECT failure_category FROM cycles WHERE cycle_number = 1").get() as { failure_category: string };
      expect(row.failure_category).toBe("build_failure");
    });
  });

  describe("updateCycleOutcome", () => {
    it("updates metrics without overwriting started_at", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, testCountBefore: 100,
      }));

      // Record the original started_at
      const before = db.prepare("SELECT started_at FROM cycles WHERE cycle_number = 1").get() as { started_at: string };

      // Update with final outcome
      updateCycleOutcome(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 3, improvementsSucceeded: 2,
        buildVerificationPassed: true, pushSucceeded: true,
        testCountBefore: 100, testCountAfter: 110,
      }));

      const after = db.prepare("SELECT * FROM cycles WHERE cycle_number = 1").get() as Record<string, unknown>;
      expect(after.started_at).toBe(before.started_at);
      expect(after.improvements_attempted).toBe(3);
      expect(after.improvements_succeeded).toBe(2);
      expect(after.build_verification_passed).toBe(1);
      expect(after.push_succeeded).toBe(1);
      expect(after.test_count_after).toBe(110);
    });

    it("persists duration_ms from outcome", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));

      updateCycleOutcome(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
        durationMs: 123456,
      }));

      const row = db.prepare("SELECT duration_ms FROM cycles WHERE cycle_number = 1").get() as { duration_ms: number | null };
      expect(row.duration_ms).toBe(123456);
    });

    it("stores null duration_ms when not set", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));

      const row = db.prepare("SELECT duration_ms FROM cycles WHERE cycle_number = 1").get() as { duration_ms: number | null };
      expect(row.duration_ms).toBeNull();
    });

    it("sets completed_at timestamp on update", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));

      updateCycleOutcome(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
        testCountBefore: 100, testCountAfter: 105,
      }));

      const row = db.prepare("SELECT completed_at FROM cycles WHERE cycle_number = 1").get() as { completed_at: string | null };
      expect(row.completed_at).toBeTruthy();
      // Should be a valid ISO timestamp
      expect(new Date(row.completed_at!).getTime()).toBeGreaterThan(0);
    });

    it("persists failureCategory from outcome", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      updateCycleOutcome(db, makeOutcome({
        cycleNumber: 1, buildVerificationPassed: false,
        failureCategory: "test_failure",
      }));
      const row = db.prepare("SELECT failure_category FROM cycles WHERE cycle_number = 1").get() as { failure_category: string };
      expect(row.failure_category).toBe("test_failure");
    });

    it("does nothing for non-existent cycle", () => {
      updateCycleOutcome(db, makeOutcome({
        cycleNumber: 999, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));

      const row = db.prepare("SELECT * FROM cycles WHERE cycle_number = 999").get();
      expect(row).toBeUndefined();
    });
  });

  describe("exportJournalJson", () => {
    it("exports entries grouped by cycle, newest first", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      insertCycle(db, makeOutcome({
        cycleNumber: 2, improvementsAttempted: 2, improvementsSucceeded: 2,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      insertJournalEntry(db, 1, "attempted", "Cycle 1 work");
      insertJournalEntry(db, 2, "attempted", "Cycle 2 work");

      const exported = exportJournalJson(db);
      expect(exported).toHaveLength(2);
      expect(exported[0].cycleNumber).toBe(2); // newest first
      expect(exported[1].cycleNumber).toBe(1);
      expect(exported[0].attempted).toBe("Cycle 2 work");
    });

    it("defaults missing sections to empty strings", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      // Only insert "attempted" — no succeeded, failed, or learnings
      insertJournalEntry(db, 1, "attempted", "Some work");

      const exported = exportJournalJson(db);
      expect(exported).toHaveLength(1);
      expect(exported[0].attempted).toBe("Some work");
      expect(exported[0].succeeded).toBe("");
      expect(exported[0].failed).toBe("");
      expect(exported[0].learnings).toBe("");
    });

    it("includes strategic_context field when present", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      insertJournalEntry(db, 1, "attempted", "Improved tests");
      insertJournalEntry(db, 1, "strategic_context", "Focusing on test coverage and code clarity.");

      const exported = exportJournalJson(db);
      expect(exported).toHaveLength(1);
      expect(exported[0].strategic_context).toBe("Focusing on test coverage and code clarity.");
    });

    it("defaults strategic_context to empty string when absent", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      insertJournalEntry(db, 1, "attempted", "Some work");

      const exported = exportJournalJson(db);
      expect(exported[0].strategic_context).toBe("");
    });

    it("groups multiple sections from the same cycle into one entry", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 2, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      insertJournalEntry(db, 1, "attempted", "First attempt");
      insertJournalEntry(db, 1, "succeeded", "One success");
      insertJournalEntry(db, 1, "failed", "One failure");
      insertJournalEntry(db, 1, "learnings", "Lesson learned");
      insertJournalEntry(db, 1, "strategic_context", "Focus on testing");

      const exported = exportJournalJson(db);
      expect(exported).toHaveLength(1);
      expect(exported[0].attempted).toBe("First attempt");
      expect(exported[0].succeeded).toBe("One success");
      expect(exported[0].failed).toBe("One failure");
      expect(exported[0].learnings).toBe("Lesson learned");
      expect(exported[0].strategic_context).toBe("Focus on testing");
    });

    it("sorts entries by cycle number descending regardless of insertion order", () => {
      // Insert cycles in non-sequential order
      insertCycle(db, makeOutcome({ cycleNumber: 3 }));
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertCycle(db, makeOutcome({ cycleNumber: 2 }));
      insertJournalEntry(db, 3, "attempted", "Third");
      insertJournalEntry(db, 1, "attempted", "First");
      insertJournalEntry(db, 2, "attempted", "Second");

      const exported = exportJournalJson(db);
      expect(exported).toHaveLength(3);
      expect(exported[0].cycleNumber).toBe(3);
      expect(exported[1].cycleNumber).toBe(2);
      expect(exported[2].cycleNumber).toBe(1);
    });

    it("returns empty array when no journal entries exist", () => {
      // Cycle exists but no journal entries
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      const exported = exportJournalJson(db);
      expect(exported).toHaveLength(0);
    });

    it("limits results when maxCycles is provided", () => {
      for (let i = 1; i <= 5; i++) {
        insertCycle(db, makeOutcome({ cycleNumber: i }));
        insertJournalEntry(db, i, "attempted", `Cycle ${i} work`);
        insertJournalEntry(db, i, "succeeded", `Cycle ${i} success`);
      }

      const exported = exportJournalJson(db, 2);
      expect(exported).toHaveLength(2);
      // Newest first
      expect(exported[0].cycleNumber).toBe(5);
      expect(exported[1].cycleNumber).toBe(4);
    });

    it("returns all entries when maxCycles exceeds total cycles", () => {
      for (let i = 1; i <= 3; i++) {
        insertCycle(db, makeOutcome({ cycleNumber: i }));
        insertJournalEntry(db, i, "attempted", `Cycle ${i}`);
      }

      const exported = exportJournalJson(db, 10);
      expect(exported).toHaveLength(3);
    });

    it("returns all entries when maxCycles is undefined", () => {
      for (let i = 1; i <= 4; i++) {
        insertCycle(db, makeOutcome({ cycleNumber: i }));
        insertJournalEntry(db, i, "attempted", `Cycle ${i}`);
      }

      const exported = exportJournalJson(db);
      expect(exported).toHaveLength(4);
    });
  });

  describe("getRecentJournalSummary", () => {
    it("returns empty string when no entries", () => {
      expect(getRecentJournalSummary(db)).toBe("");
    });

    it("returns markdown summary of recent cycles", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      insertJournalEntry(db, 1, "attempted", "Did something");
      insertJournalEntry(db, 1, "succeeded", "It worked");

      const summary = getRecentJournalSummary(db);
      expect(summary).toContain("Cycle 1");
      expect(summary).toContain("Did something");
      expect(summary).toContain("It worked");
    });

    it("truncates output when exceeding maxChars budget", () => {
      // Insert 3 cycles with journal entries
      for (let i = 1; i <= 3; i++) {
        insertCycle(db, makeOutcome({ cycleNumber: i }));
        insertJournalEntry(db, i, "attempted", `Cycle ${i} attempt content`);
        insertJournalEntry(db, i, "succeeded", `Cycle ${i} success content`);
        insertJournalEntry(db, i, "failed", "");
        insertJournalEntry(db, i, "learnings", `Cycle ${i} learnings`);
      }

      // With a large budget, all 3 cycles should appear
      const fullSummary = getRecentJournalSummary(db, 100000);
      expect(fullSummary).toContain("Cycle 3");
      expect(fullSummary).toContain("Cycle 2");
      expect(fullSummary).toContain("Cycle 1");

      // Get the length of a single cycle's section to pick a tight budget
      const singleCycleSummary = getRecentJournalSummary(db, 1);
      // With maxChars=1, only the first entry should appear (always allowed even if over budget)
      expect(singleCycleSummary).toContain("Cycle 3"); // newest first
      expect(singleCycleSummary).not.toContain("Cycle 2");
      expect(singleCycleSummary).not.toContain("Cycle 1");
    });

    it("truncates at exact boundary allowing partial cycles", () => {
      // Insert 3 cycles
      for (let i = 1; i <= 3; i++) {
        insertCycle(db, makeOutcome({ cycleNumber: i }));
        insertJournalEntry(db, i, "attempted", `Attempt ${i}`);
        insertJournalEntry(db, i, "succeeded", `Success ${i}`);
        insertJournalEntry(db, i, "failed", "");
        insertJournalEntry(db, i, "learnings", `Learning ${i}`);
      }

      // Get the full summary and measure single-cycle length
      const fullSummary = getRecentJournalSummary(db, 100000);
      const cycle3Section = fullSummary.split("---")[0] + "---\n";
      const twoCycleBudget = cycle3Section.length * 2 + 1;

      // With budget for ~2 cycles, the third should be truncated
      const result = getRecentJournalSummary(db, twoCycleBudget);
      expect(result).toContain("Cycle 3");
      expect(result).toContain("Cycle 2");
      expect(result).not.toContain("Cycle 1");
    });

    it("excludes strategic_context by default even when present", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertJournalEntry(db, 1, "attempted", "Improved tests");
      insertJournalEntry(db, 1, "succeeded", "Tests pass");
      insertJournalEntry(db, 1, "failed", "");
      insertJournalEntry(db, 1, "learnings", "Testing is good");
      insertJournalEntry(db, 1, "strategic_context", "Focusing on test coverage and reliability.");

      const summary = getRecentJournalSummary(db);
      expect(summary).not.toContain("### Strategic Context");
      expect(summary).not.toContain("Focusing on test coverage and reliability.");
    });

    it("omits strategic context section when empty", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertJournalEntry(db, 1, "attempted", "Some work");
      insertJournalEntry(db, 1, "succeeded", "");
      insertJournalEntry(db, 1, "failed", "");
      insertJournalEntry(db, 1, "learnings", "");

      const summary = getRecentJournalSummary(db);
      expect(summary).not.toContain("Strategic Context");
    });

    it("always includes at least one cycle even if it exceeds maxChars", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertJournalEntry(db, 1, "attempted", "A".repeat(500));
      insertJournalEntry(db, 1, "succeeded", "");
      insertJournalEntry(db, 1, "failed", "");
      insertJournalEntry(db, 1, "learnings", "");

      // Even with maxChars=10, the first cycle is always included
      const summary = getRecentJournalSummary(db, 10);
      expect(summary).toContain("Cycle 1");
      expect(summary).toContain("A".repeat(500));
      expect(summary.length).toBeGreaterThan(10);
    });

    it("omits section headers for empty fields to save prompt tokens", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertJournalEntry(db, 1, "attempted", "Did work");
      insertJournalEntry(db, 1, "succeeded", "");
      insertJournalEntry(db, 1, "failed", "");
      insertJournalEntry(db, 1, "learnings", "Learned something");

      const summary = getRecentJournalSummary(db);
      expect(summary).toContain("### What was attempted");
      expect(summary).toContain("### Learnings");
      expect(summary).not.toContain("### What succeeded");
      expect(summary).not.toContain("### What failed");
    });

    it("includes all non-strategic section headers when all fields have content", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertJournalEntry(db, 1, "attempted", "A");
      insertJournalEntry(db, 1, "succeeded", "B");
      insertJournalEntry(db, 1, "failed", "C");
      insertJournalEntry(db, 1, "learnings", "D");
      insertJournalEntry(db, 1, "strategic_context", "E");

      const summary = getRecentJournalSummary(db, 4000, 5);
      expect(summary).toContain("### What was attempted");
      expect(summary).toContain("### What succeeded");
      expect(summary).toContain("### What failed");
      expect(summary).toContain("### Learnings");
      expect(summary).not.toContain("### Strategic Context");
    });

    it("default maxCycles limits to 5 cycles", () => {
      // Insert 8 cycles with journal entries
      for (let i = 1; i <= 8; i++) {
        insertCycle(db, makeOutcome({ cycleNumber: i }));
        insertJournalEntry(db, i, "attempted", `Cycle ${i} work`);
      }
      // Default call (maxCycles=5) should include cycles 8..4 but not 3, 2, 1
      const summary = getRecentJournalSummary(db, 100000);
      expect(summary).toContain("Cycle 8");
      expect(summary).toContain("Cycle 4");
      expect(summary).not.toContain("Cycle 3");
      expect(summary).not.toContain("Cycle 2");
      expect(summary).not.toContain("Cycle 1");
    });

    it("explicit maxCycles overrides the default", () => {
      // Insert 6 cycles
      for (let i = 1; i <= 6; i++) {
        insertCycle(db, makeOutcome({ cycleNumber: i }));
        insertJournalEntry(db, i, "attempted", `Cycle ${i} work`);
      }
      // maxCycles=2 should include only cycles 6 and 5
      const summary = getRecentJournalSummary(db, 100000, 2);
      expect(summary).toContain("Cycle 6");
      expect(summary).toContain("Cycle 5");
      expect(summary).not.toContain("Cycle 4");
      expect(summary).not.toContain("Cycle 3");
    });
  });

  describe("insertPhaseUsage", () => {
    it("inserts usage data", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertPhaseUsage(db, 1, {
        phase: "Assessment",
        totalCostUsd: 1.5,
        inputTokens: 5000,
        outputTokens: 2000,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 50,
        durationMs: 30000,
        numTurns: 10,
      });

      const rows = db.prepare("SELECT * FROM phase_usage WHERE cycle_number = 1").all();
      expect(rows).toHaveLength(1);
    });
  });

  describe("insertIssueAction + hasIssueAction", () => {
    it("inserts issue action", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertIssueAction(db, 1, 42, "acknowledged");

      const rows = db.prepare("SELECT * FROM issue_actions WHERE cycle_number = 1").all();
      expect(rows).toHaveLength(1);
    });

    it("returns false when no action exists", () => {
      expect(hasIssueAction(db, 42, "acknowledged")).toBe(false);
    });

    it("returns true when action exists", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertIssueAction(db, 1, 42, "acknowledged");
      expect(hasIssueAction(db, 42, "acknowledged")).toBe(true);
    });

    it("distinguishes between different actions", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertIssueAction(db, 1, 42, "acknowledged");
      expect(hasIssueAction(db, 42, "acknowledged")).toBe(true);
      expect(hasIssueAction(db, 42, "closed")).toBe(false);
    });

    it("is idempotent — duplicate inserts are silently ignored", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertIssueAction(db, 1, 42, "acknowledged");
      insertIssueAction(db, 1, 42, "acknowledged"); // duplicate

      const rows = db.prepare("SELECT * FROM issue_actions WHERE issue_number = 42 AND action = 'acknowledged'").all();
      expect(rows).toHaveLength(1);
    });

    it("distinguishes between different issue numbers", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertIssueAction(db, 1, 42, "closed");
      expect(hasIssueAction(db, 42, "closed")).toBe(true);
      expect(hasIssueAction(db, 99, "closed")).toBe(false);
    });
  });

  describe("getCycleStats", () => {
    it("returns zeros when no cycles exist", () => {
      const stats = getCycleStats(db);
      expect(stats.totalCycles).toBe(0);
      expect(stats.successRate).toBe(0);
      expect(stats.avgImprovements).toBe(0);
      expect(stats.avgConversionRate).toBeNull();
      expect(stats.testCountTrend).toBeNull();
      expect(stats.recentFailures).toBe(0);
      expect(stats.avgDurationMinutes).toBeNull();
      expect(stats.totalCostUsd).toBe(0);
      expect(stats.avgCostPerCycle).toBe(0);
    });

    it("computes correct success rate", () => {
      // 2 successful, 1 failed = 67%
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 2, improvementsSucceeded: 2,
        buildVerificationPassed: true, pushSucceeded: true,
        testCountBefore: 100, testCountAfter: 105,
      }));
      insertCycle(db, makeOutcome({
        cycleNumber: 2, improvementsAttempted: 1,
        testCountBefore: 105,
      }));
      insertCycle(db, makeOutcome({
        cycleNumber: 3, improvementsAttempted: 3, improvementsSucceeded: 3,
        buildVerificationPassed: true, pushSucceeded: true,
        testCountBefore: 105, testCountAfter: 115,
      }));

      const stats = getCycleStats(db);
      expect(stats.totalCycles).toBe(3);
      expect(stats.successRate).toBe(67);
      expect(stats.avgImprovements).toBe(1.7); // (2+0+3)/3 = 1.666... rounds to 1.7
      expect(stats.avgConversionRate).toBe(83); // (2+0+3)/(2+1+3) = 5/6 = 83%
      expect(stats.recentFailures).toBe(1);
    });

    it("computes test count trend from oldest to newest", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
        testCountBefore: 100, testCountAfter: 110,
      }));
      insertCycle(db, makeOutcome({
        cycleNumber: 2, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
        testCountBefore: 110, testCountAfter: 130,
      }));

      const stats = getCycleStats(db);
      // newest after (130) - oldest before (100) = 30
      expect(stats.testCountTrend).toBe(30);
    });

    it("computes test count trend from a single cycle with both counts", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
        testCountBefore: 50, testCountAfter: 58,
      }));

      const stats = getCycleStats(db);
      // Single cycle: after (58) - before (50) = 8
      expect(stats.testCountTrend).toBe(8);
    });

    it("returns null testCountTrend when single cycle has null test_count_before", () => {
      // Row is excluded by the both-non-null filter, so no cycle qualifies
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
        testCountBefore: null, testCountAfter: 58,
      }));

      const stats = getCycleStats(db);
      expect(stats.testCountTrend).toBeNull();
    });

    it("returns null testCountTrend when single cycle has null test_count_after", () => {
      // Row is excluded by the both-non-null filter, so no cycle qualifies
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
        testCountBefore: 50, testCountAfter: null,
      }));

      const stats = getCycleStats(db);
      expect(stats.testCountTrend).toBeNull();
    });

    it("computes avgDurationMinutes from duration_ms when available", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
        durationMs: 600000, // 10 minutes
      }));
      updateCycleOutcome(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
        durationMs: 600000,
      }));

      const stats = getCycleStats(db);
      expect(stats.avgDurationMinutes).toBe(10);
    });

    it("falls back to timestamp subtraction when duration_ms is null", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      // Manually set started_at and completed_at for a known duration (10 minutes)
      db.prepare("UPDATE cycles SET started_at = ?, completed_at = ? WHERE cycle_number = 1").run(
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:10:00.000Z",
      );

      const stats = getCycleStats(db);
      expect(stats.avgDurationMinutes).toBe(10);
    });

    it("ignores rows with malformed completed_at timestamps", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      // Set a malformed completed_at that would produce NaN
      db.prepare("UPDATE cycles SET started_at = ?, completed_at = ? WHERE cycle_number = 1").run(
        "2026-01-01T00:00:00.000Z",
        "not-a-date",
      );

      const stats = getCycleStats(db);
      // Should be null because the only row has NaN duration and is skipped
      expect(stats.avgDurationMinutes).toBeNull();
    });

    it("returns null avgDurationMinutes when no completed_at exists", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      // No updateCycleOutcome called, so completed_at is null

      const stats = getCycleStats(db);
      expect(stats.avgDurationMinutes).toBeNull();
    });

    it("averages duration across mixed duration_ms and timestamp sources", () => {
      // Cycle 1: 10 minutes via duration_ms
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
        durationMs: 600000, // 10 minutes
      }));
      updateCycleOutcome(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
        durationMs: 600000,
      }));
      // Cycle 2: 20 minutes via timestamp subtraction (no duration_ms)
      insertCycle(db, makeOutcome({
        cycleNumber: 2, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      db.prepare("UPDATE cycles SET started_at = ?, completed_at = ? WHERE cycle_number = 2").run(
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:20:00.000Z",
      );

      const stats = getCycleStats(db);
      // (10 + 20) / 2 = 15 minutes average
      expect(stats.avgDurationMinutes).toBe(15);
    });

    it("respects limit parameter", () => {
      for (let i = 1; i <= 10; i++) {
        insertCycle(db, makeOutcome({
          cycleNumber: i, improvementsAttempted: 1, improvementsSucceeded: 1,
          buildVerificationPassed: true, pushSucceeded: true,
        }));
      }

      const stats = getCycleStats(db, 3);
      expect(stats.totalCycles).toBe(3);
    });

    it("aggregates cost from phase_usage", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      insertCycle(db, makeOutcome({
        cycleNumber: 2, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      insertPhaseUsage(db, 1, {
        phase: "Assessment", totalCostUsd: 0.50, inputTokens: 1000,
        outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        durationMs: 5000, numTurns: 3,
      });
      insertPhaseUsage(db, 1, {
        phase: "Evolution", totalCostUsd: 1.25, inputTokens: 2000,
        outputTokens: 1000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        durationMs: 10000, numTurns: 5,
      });
      insertPhaseUsage(db, 2, {
        phase: "Assessment", totalCostUsd: 0.75, inputTokens: 1500,
        outputTokens: 700, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        durationMs: 6000, numTurns: 4,
      });

      const stats = getCycleStats(db);
      expect(stats.totalCostUsd).toBe(2.5);
      expect(stats.avgCostPerCycle).toBe(1.25);
    });

    it("returns zero cost when no phase_usage rows exist", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));

      const stats = getCycleStats(db);
      expect(stats.totalCostUsd).toBe(0);
      expect(stats.avgCostPerCycle).toBe(0);
    });

    it("aggregates token counts from phase_usage", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      insertPhaseUsage(db, 1, {
        phase: "Assessment", totalCostUsd: 0.50, inputTokens: 3000,
        outputTokens: 1500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        durationMs: 5000, numTurns: 3,
      });
      insertPhaseUsage(db, 1, {
        phase: "Evolution", totalCostUsd: 1.00, inputTokens: 5000,
        outputTokens: 2500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        durationMs: 10000, numTurns: 5,
      });

      const stats = getCycleStats(db);
      expect(stats.totalInputTokens).toBe(8000);
      expect(stats.totalOutputTokens).toBe(4000);
    });

    it("returns zero tokens when no phase_usage rows exist", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));

      const stats = getCycleStats(db);
      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
    });

    it("returns empty failureCategoryBreakdown when all cycles succeeded", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));

      const stats = getCycleStats(db);
      expect(stats.failureCategoryBreakdown).toEqual({});
    });

    it("counts failure categories across cycles", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, buildVerificationPassed: false, pushSucceeded: false,
        failureCategory: "test_failure",
      }));
      insertCycle(db, makeOutcome({
        cycleNumber: 2, buildVerificationPassed: false, pushSucceeded: false,
        failureCategory: "test_failure",
      }));
      insertCycle(db, makeOutcome({
        cycleNumber: 3, buildVerificationPassed: false, pushSucceeded: false,
        failureCategory: "build_failure",
      }));
      insertCycle(db, makeOutcome({
        cycleNumber: 4, buildVerificationPassed: true, pushSucceeded: true,
        failureCategory: "none",
      }));

      const stats = getCycleStats(db);
      expect(stats.failureCategoryBreakdown["test_failure"]).toBe(2);
      expect(stats.failureCategoryBreakdown["build_failure"]).toBe(1);
      expect(stats.failureCategoryBreakdown["none"]).toBeUndefined();
    });

    it("recentFailures does not count failing cycles outside the newest 5", () => {
      // Cycles 1–2 fail (oldest), cycles 3–7 all pass (newest 5)
      for (let i = 1; i <= 2; i++) {
        insertCycle(db, makeOutcome({
          cycleNumber: i, buildVerificationPassed: false, pushSucceeded: false,
          failureCategory: "build_failure",
        }));
      }
      for (let i = 3; i <= 7; i++) {
        insertCycle(db, makeOutcome({
          cycleNumber: i, improvementsAttempted: 1, improvementsSucceeded: 1,
          buildVerificationPassed: true, pushSucceeded: true,
        }));
      }

      const stats = getCycleStats(db);
      // The 5 most recent cycles (3–7) all passed, so recentFailures must be 0
      expect(stats.recentFailures).toBe(0);
    });

    it("returns null conversion rate when no cycles have attempts", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 0, improvementsSucceeded: 0,
        buildVerificationPassed: true, pushSucceeded: true,
      }));

      const stats = getCycleStats(db);
      expect(stats.avgConversionRate).toBeNull();
    });

    it("returns null conversion rate when multiple cycles all have zero attempts", () => {
      // Both cycles have 0 improvements_attempted — the cyclesWithAttempts
      // filter should exclude all of them, yielding null (not 0 or NaN).
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 0, improvementsSucceeded: 0,
        buildVerificationPassed: false, pushSucceeded: false,
      }));
      insertCycle(db, makeOutcome({
        cycleNumber: 2, improvementsAttempted: 0, improvementsSucceeded: 0,
        buildVerificationPassed: false, pushSucceeded: false,
      }));

      const stats = getCycleStats(db);
      expect(stats.totalCycles).toBe(2);
      expect(stats.avgConversionRate).toBeNull();
    });

    it("computes 100% conversion rate when all attempted improvements succeed", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 2, improvementsSucceeded: 2,
        buildVerificationPassed: true, pushSucceeded: true,
      }));

      const stats = getCycleStats(db);
      expect(stats.avgConversionRate).toBe(100);
    });

    it("computes conversion rate across mixed cycles, ignoring zero-attempt cycles", () => {
      // cycle 1: 2 attempted, 1 succeeded
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 2, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      // cycle 2: 0 attempted (should be excluded from denominator)
      insertCycle(db, makeOutcome({
        cycleNumber: 2, improvementsAttempted: 0, improvementsSucceeded: 0,
        buildVerificationPassed: false, pushSucceeded: false,
      }));
      // cycle 3: 3 attempted, 3 succeeded
      insertCycle(db, makeOutcome({
        cycleNumber: 3, improvementsAttempted: 3, improvementsSucceeded: 3,
        buildVerificationPassed: true, pushSucceeded: true,
      }));

      const stats = getCycleStats(db);
      // (1+3) / (2+3) = 4/5 = 80%
      expect(stats.avgConversionRate).toBe(80);
    });

    it("rounds conversion rate to nearest integer", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 3, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));

      const stats = getCycleStats(db);
      // 1/3 = 33.33% → rounds to 33
      expect(stats.avgConversionRate).toBe(33);
    });
  });

  describe("formatCycleStats", () => {
    it("returns message when no data", () => {
      const result = formatCycleStats({
        totalCycles: 0, successRate: 0, avgImprovements: 0, avgConversionRate: null,
        testCountTrend: null, recentFailures: 0, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 0, totalOutputTokens: 0,
        failureCategoryBreakdown: {},
      });
      expect(result).toBe("No previous cycle data available.");
    });

    it("includes all metrics when data exists", () => {
      const result = formatCycleStats({
        totalCycles: 10, successRate: 80, avgImprovements: 1.5, avgConversionRate: 75,
        testCountTrend: 42, recentFailures: 1, avgDurationMinutes: 8.5,
        totalCostUsd: 15.50, avgCostPerCycle: 1.55,
        totalInputTokens: 50000, totalOutputTokens: 25000,
        failureCategoryBreakdown: {},
      });
      expect(result).toContain("10");
      expect(result).toContain("80%");
      expect(result).toContain("1.5");
      expect(result).toContain("75%");
      expect(result).toContain("+42");
      expect(result).toContain("8.5 min");
      expect(result).toContain("$15.50 total / $1.55 avg");
      expect(result).toContain("50k in / 25k out tokens");
      expect(result).toContain("1");
    });

    it("omits conversion rate line when avgConversionRate is null", () => {
      const result = formatCycleStats({
        totalCycles: 3, successRate: 100, avgImprovements: 0, avgConversionRate: null,
        testCountTrend: null, recentFailures: 0, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 0, totalOutputTokens: 0,
        failureCategoryBreakdown: {},
      });
      expect(result).not.toContain("Conversion rate");
    });

    it("displays negative test count trend without plus sign", () => {
      const result = formatCycleStats({
        totalCycles: 5, successRate: 60, avgImprovements: 1, avgConversionRate: null,
        testCountTrend: -7, recentFailures: 2, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 0, totalOutputTokens: 0,
        failureCategoryBreakdown: {},
      });
      expect(result).toContain("-7");
      expect(result).not.toContain("+-7");
    });

    it("omits duration when null", () => {
      const result = formatCycleStats({
        totalCycles: 5, successRate: 100, avgImprovements: 2, avgConversionRate: null,
        testCountTrend: null, recentFailures: 0, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 0, totalOutputTokens: 0,
        failureCategoryBreakdown: {},
      });
      expect(result).not.toContain("duration");
      expect(result).not.toContain("cost");
    });

    it("omits cost line when cost and tokens are all zero", () => {
      const result = formatCycleStats({
        totalCycles: 5, successRate: 100, avgImprovements: 2, avgConversionRate: null,
        testCountTrend: null, recentFailures: 0, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 0, totalOutputTokens: 0,
        failureCategoryBreakdown: {},
      });
      expect(result).not.toContain("tokens");
      expect(result).not.toContain("Cost");
    });

    it("formats small token counts without k suffix", () => {
      const result = formatCycleStats({
        totalCycles: 1, successRate: 100, avgImprovements: 1, avgConversionRate: null,
        testCountTrend: null, recentFailures: 0, avgDurationMinutes: null,
        totalCostUsd: 0.10, avgCostPerCycle: 0.10,
        totalInputTokens: 500, totalOutputTokens: 200,
        failureCategoryBreakdown: {},
      });
      expect(result).toContain("500 in / 200 out tokens");
    });

    it("renders failure breakdown when recentFailures > 0 and breakdown is non-empty", () => {
      const result = formatCycleStats({
        totalCycles: 5, successRate: 60, avgImprovements: 1, avgConversionRate: null,
        testCountTrend: null, recentFailures: 2, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 0, totalOutputTokens: 0,
        failureCategoryBreakdown: { test_failure: 3, build_failure: 1 },
      });
      expect(result).toContain("Failure breakdown");
      expect(result).toContain("3 test_failure");
      expect(result).toContain("1 build_failure");
    });

    it("omits failure breakdown when recentFailures is 0", () => {
      const result = formatCycleStats({
        totalCycles: 5, successRate: 100, avgImprovements: 1, avgConversionRate: null,
        testCountTrend: null, recentFailures: 0, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 0, totalOutputTokens: 0,
        failureCategoryBreakdown: { test_failure: 1 },
      });
      expect(result).not.toContain("Failure breakdown");
    });

    it("renders cost-only line when tokens are zero", () => {
      const result = formatCycleStats({
        totalCycles: 3, successRate: 100, avgImprovements: 1, avgConversionRate: null,
        testCountTrend: null, recentFailures: 0, avgDurationMinutes: null,
        totalCostUsd: 2.50, avgCostPerCycle: 0.83, totalInputTokens: 0, totalOutputTokens: 0,
        failureCategoryBreakdown: {},
      });
      expect(result).toContain("$2.50 total / $0.83 avg");
      expect(result).not.toContain("tokens");
    });

    it("renders tokens-only line when cost is zero", () => {
      const result = formatCycleStats({
        totalCycles: 3, successRate: 100, avgImprovements: 1, avgConversionRate: null,
        testCountTrend: null, recentFailures: 0, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 500, totalOutputTokens: 200,
        failureCategoryBreakdown: {},
      });
      expect(result).toContain("500 in / 200 out tokens");
      expect(result).not.toContain("$");
    });

    it("renders token line when only input tokens are non-zero", () => {
      const result = formatCycleStats({
        totalCycles: 2, successRate: 100, avgImprovements: 1, avgConversionRate: null,
        testCountTrend: null, recentFailures: 0, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 400, totalOutputTokens: 0,
        failureCategoryBreakdown: {},
      });
      expect(result).toContain("400 in / 0 out tokens");
      expect(result).not.toContain("$");
    });

    it("renders token line when only output tokens are non-zero", () => {
      const result = formatCycleStats({
        totalCycles: 2, successRate: 100, avgImprovements: 1, avgConversionRate: null,
        testCountTrend: null, recentFailures: 0, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 0, totalOutputTokens: 300,
        failureCategoryBreakdown: {},
      });
      expect(result).toContain("0 in / 300 out tokens");
      expect(result).not.toContain("$");
    });

    it("omits failure breakdown when breakdown is empty", () => {
      const result = formatCycleStats({
        totalCycles: 5, successRate: 80, avgImprovements: 1, avgConversionRate: null,
        testCountTrend: null, recentFailures: 1, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 0, totalOutputTokens: 0,
        failureCategoryBreakdown: {},
      });
      expect(result).not.toContain("Failure breakdown");
    });
  });

  describe("validateRow / validateOptionalRow / validateRows", () => {
    it("validateRow passes for matching schema", () => {
      const row = { name: "bloom", count: 42 };
      const result = validateRow<{ name: string; count: number }>(
        row, { name: "string", count: "number" }, "test",
      );
      expect(result).toEqual({ name: "bloom", count: 42 });
    });

    it("validateRow throws for wrong field type", () => {
      expect(() => validateRow({ count: "not-a-number" }, { count: "number" }, "test"))
        .toThrow('test: expected "count" to be number, got string');
    });

    it("validateRow throws for undefined row", () => {
      expect(() => validateRow(undefined, { id: "number" }, "test"))
        .toThrow("test: expected a row but got undefined");
    });

    it("validateRow throws for null row", () => {
      expect(() => validateRow(null, { id: "number" }, "test"))
        .toThrow("test: expected row object, got object");
    });

    it("validateOptionalRow returns undefined for undefined input", () => {
      expect(validateOptionalRow(undefined, { id: "number" }, "test")).toBeUndefined();
    });

    it("validateOptionalRow throws for primitive (non-object) input", () => {
      expect(() => validateOptionalRow(42, {}, "test")).toThrow("got number");
    });

    it("validateOptionalRow validates nullable number fields", () => {
      const row = { val: null };
      const result = validateOptionalRow<{ val: number | null }>(row, { val: "number?" }, "test");
      expect(result).toEqual({ val: null });
    });

    it("validateOptionalRow rejects string for number? field", () => {
      expect(() => validateOptionalRow({ val: "oops" }, { val: "number?" }, "test"))
        .toThrow('expected "val" to be number|null');
    });

    it("validateOptionalRow validates nullable string fields", () => {
      expect(validateOptionalRow({ s: null }, { s: "string?" }, "test")).toEqual({ s: null });
      expect(validateOptionalRow({ s: "hello" }, { s: "string?" }, "test")).toEqual({ s: "hello" });
    });

    it("validateOptionalRow rejects number for string? field", () => {
      expect(() => validateOptionalRow({ s: 123 }, { s: "string?" }, "test"))
        .toThrow('expected "s" to be string|null');
    });

    it("validateRows validates all rows in array", () => {
      const rows = [{ id: 1 }, { id: 2 }];
      const result = validateRows<{ id: number }>(rows, { id: "number" }, "test");
      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it("validateRows throws with index on bad row", () => {
      const rows = [{ id: 1 }, { id: "bad" }];
      expect(() => validateRows(rows, { id: "number" }, "test"))
        .toThrow('test[1]: expected "id" to be number, got string');
    });

    it("validateRows returns empty array for empty input", () => {
      expect(validateRows([], { id: "number" }, "test")).toEqual([]);
    });

    it("throws on unrecognised field spec instead of silently passing", () => {
      // "boolean" is not a valid FieldType; the default branch must catch it
      expect(() => validateRow({ flag: true }, { flag: "boolean" as never }, "test"))
        .toThrow('unknown field spec "boolean" for key "flag"');
    });
  });
});
