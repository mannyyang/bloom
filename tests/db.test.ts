import { describe, it, expect, beforeEach } from "vitest";
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
import type Database from "better-sqlite3";
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

    it("includes strategic_context in summary when present", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertJournalEntry(db, 1, "attempted", "Improved tests");
      insertJournalEntry(db, 1, "succeeded", "Tests pass");
      insertJournalEntry(db, 1, "failed", "");
      insertJournalEntry(db, 1, "learnings", "Testing is good");
      insertJournalEntry(db, 1, "strategic_context", "Focusing on test coverage and reliability.");

      const summary = getRecentJournalSummary(db);
      expect(summary).toContain("### Strategic Context");
      expect(summary).toContain("Focusing on test coverage and reliability.");
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

    it("includes strategic_context section in budget calculation", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertCycle(db, makeOutcome({ cycleNumber: 2 }));
      insertJournalEntry(db, 1, "attempted", "Work 1");
      insertJournalEntry(db, 1, "succeeded", "");
      insertJournalEntry(db, 1, "failed", "");
      insertJournalEntry(db, 1, "learnings", "");
      insertJournalEntry(db, 2, "attempted", "Work 2");
      insertJournalEntry(db, 2, "succeeded", "");
      insertJournalEntry(db, 2, "failed", "");
      insertJournalEntry(db, 2, "learnings", "");
      insertJournalEntry(db, 2, "strategic_context", "X".repeat(200));

      // The strategic context adds significant length to cycle 2's section
      const fullSummary = getRecentJournalSummary(db, 100000);
      expect(fullSummary).toContain("Strategic Context");
      expect(fullSummary).toContain("X".repeat(200));

      // With a tight budget that fits cycle 2 (with its long strategic context)
      // but not cycle 1, only cycle 2 should appear
      const cycle2Section = fullSummary.split("---")[0] + "---\n";
      const tightBudget = cycle2Section.length + 5;
      const truncated = getRecentJournalSummary(db, tightBudget);
      expect(truncated).toContain("Cycle 2");
      expect(truncated).not.toContain("Cycle 1");
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

    it("includes all section headers when all fields have content", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertJournalEntry(db, 1, "attempted", "A");
      insertJournalEntry(db, 1, "succeeded", "B");
      insertJournalEntry(db, 1, "failed", "C");
      insertJournalEntry(db, 1, "learnings", "D");
      insertJournalEntry(db, 1, "strategic_context", "E");

      const summary = getRecentJournalSummary(db);
      expect(summary).toContain("### What was attempted");
      expect(summary).toContain("### What succeeded");
      expect(summary).toContain("### What failed");
      expect(summary).toContain("### Learnings");
      expect(summary).toContain("### Strategic Context");
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

    it("computes avgDurationMinutes when completed_at is set", () => {
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

    it("returns null avgDurationMinutes when no completed_at exists", () => {
      insertCycle(db, makeOutcome({
        cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1,
        buildVerificationPassed: true, pushSucceeded: true,
      }));
      // No updateCycleOutcome called, so completed_at is null

      const stats = getCycleStats(db);
      expect(stats.avgDurationMinutes).toBeNull();
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
  });

  describe("formatCycleStats", () => {
    it("returns message when no data", () => {
      const result = formatCycleStats({
        totalCycles: 0, successRate: 0, avgImprovements: 0,
        testCountTrend: null, recentFailures: 0, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 0, totalOutputTokens: 0,
      });
      expect(result).toBe("No previous cycle data available.");
    });

    it("includes all metrics when data exists", () => {
      const result = formatCycleStats({
        totalCycles: 10, successRate: 80, avgImprovements: 1.5,
        testCountTrend: 42, recentFailures: 1, avgDurationMinutes: 8.5,
        totalCostUsd: 15.50, avgCostPerCycle: 1.55,
        totalInputTokens: 50000, totalOutputTokens: 25000,
      });
      expect(result).toContain("10");
      expect(result).toContain("80%");
      expect(result).toContain("1.5");
      expect(result).toContain("+42");
      expect(result).toContain("8.5 min");
      expect(result).toContain("$15.50");
      expect(result).toContain("$1.55");
      expect(result).toContain("50k in / 25k out");
      expect(result).toContain("1");
    });

    it("displays negative test count trend without plus sign", () => {
      const result = formatCycleStats({
        totalCycles: 5, successRate: 60, avgImprovements: 1,
        testCountTrend: -7, recentFailures: 2, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 0, totalOutputTokens: 0,
      });
      expect(result).toContain("-7");
      expect(result).not.toContain("+-7");
    });

    it("omits duration when null", () => {
      const result = formatCycleStats({
        totalCycles: 5, successRate: 100, avgImprovements: 2,
        testCountTrend: null, recentFailures: 0, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 0, totalOutputTokens: 0,
      });
      expect(result).not.toContain("duration");
      expect(result).not.toContain("cost");
    });

    it("omits tokens line when both are zero", () => {
      const result = formatCycleStats({
        totalCycles: 5, successRate: 100, avgImprovements: 2,
        testCountTrend: null, recentFailures: 0, avgDurationMinutes: null,
        totalCostUsd: 0, avgCostPerCycle: 0, totalInputTokens: 0, totalOutputTokens: 0,
      });
      expect(result).not.toContain("tokens");
    });

    it("formats small token counts without k suffix", () => {
      const result = formatCycleStats({
        totalCycles: 1, successRate: 100, avgImprovements: 1,
        testCountTrend: null, recentFailures: 0, avgDurationMinutes: null,
        totalCostUsd: 0.10, avgCostPerCycle: 0.10,
        totalInputTokens: 500, totalOutputTokens: 200,
      });
      expect(result).toContain("500 in / 200 out");
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
  });
});
