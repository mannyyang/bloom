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
} from "../src/db.js";
import type Database from "better-sqlite3";

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
      insertCycle(db, {
        cycleNumber: 5, preflightPassed: true, improvementsAttempted: 0,
        improvementsSucceeded: 0, buildVerificationPassed: false,
        pushSucceeded: false, testCountBefore: null, testCountAfter: null,
      });
      insertCycle(db, {
        cycleNumber: 10, preflightPassed: true, improvementsAttempted: 0,
        improvementsSucceeded: 0, buildVerificationPassed: false,
        pushSucceeded: false, testCountBefore: null, testCountAfter: null,
      });
      expect(getLatestCycleNumber(db)).toBe(10);
    });
  });

  describe("insertCycle + insertJournalEntry", () => {
    it("inserts and retrieves journal entries", () => {
      insertCycle(db, {
        cycleNumber: 1, preflightPassed: true, improvementsAttempted: 2,
        improvementsSucceeded: 1, buildVerificationPassed: true,
        pushSucceeded: true, testCountBefore: 100, testCountAfter: 105,
      });
      insertJournalEntry(db, 1, "attempted", "Tried two things");
      insertJournalEntry(db, 1, "succeeded", "One worked");
      insertJournalEntry(db, 1, "failed", "One didn't");
      insertJournalEntry(db, 1, "learnings", "Learned stuff");

      const entries = getJournalEntries(db);
      expect(entries).toHaveLength(4);
      expect(entries[0].section).toBe("attempted");
      expect(entries[0].content).toBe("Tried two things");
    });
  });

  describe("updateCycleOutcome", () => {
    it("updates metrics without overwriting started_at", () => {
      insertCycle(db, {
        cycleNumber: 1, preflightPassed: true, improvementsAttempted: 0,
        improvementsSucceeded: 0, buildVerificationPassed: false,
        pushSucceeded: false, testCountBefore: 100, testCountAfter: null,
      });

      // Record the original started_at
      const before = db.prepare("SELECT started_at FROM cycles WHERE cycle_number = 1").get() as { started_at: string };

      // Update with final outcome
      updateCycleOutcome(db, {
        cycleNumber: 1, preflightPassed: true, improvementsAttempted: 3,
        improvementsSucceeded: 2, buildVerificationPassed: true,
        pushSucceeded: true, testCountBefore: 100, testCountAfter: 110,
      });

      const after = db.prepare("SELECT * FROM cycles WHERE cycle_number = 1").get() as Record<string, unknown>;
      expect(after.started_at).toBe(before.started_at);
      expect(after.improvements_attempted).toBe(3);
      expect(after.improvements_succeeded).toBe(2);
      expect(after.build_verification_passed).toBe(1);
      expect(after.push_succeeded).toBe(1);
      expect(after.test_count_after).toBe(110);
    });

    it("does nothing for non-existent cycle", () => {
      updateCycleOutcome(db, {
        cycleNumber: 999, preflightPassed: true, improvementsAttempted: 1,
        improvementsSucceeded: 1, buildVerificationPassed: true,
        pushSucceeded: true, testCountBefore: null, testCountAfter: null,
      });

      const row = db.prepare("SELECT * FROM cycles WHERE cycle_number = 999").get();
      expect(row).toBeUndefined();
    });
  });

  describe("exportJournalJson", () => {
    it("exports entries grouped by cycle, newest first", () => {
      insertCycle(db, {
        cycleNumber: 1, preflightPassed: true, improvementsAttempted: 1,
        improvementsSucceeded: 1, buildVerificationPassed: true,
        pushSucceeded: true, testCountBefore: null, testCountAfter: null,
      });
      insertCycle(db, {
        cycleNumber: 2, preflightPassed: true, improvementsAttempted: 2,
        improvementsSucceeded: 2, buildVerificationPassed: true,
        pushSucceeded: true, testCountBefore: null, testCountAfter: null,
      });
      insertJournalEntry(db, 1, "attempted", "Cycle 1 work");
      insertJournalEntry(db, 2, "attempted", "Cycle 2 work");

      const exported = exportJournalJson(db);
      expect(exported).toHaveLength(2);
      expect(exported[0].cycleNumber).toBe(2); // newest first
      expect(exported[1].cycleNumber).toBe(1);
      expect(exported[0].attempted).toBe("Cycle 2 work");
    });
  });

  describe("getRecentJournalSummary", () => {
    it("returns empty string when no entries", () => {
      expect(getRecentJournalSummary(db)).toBe("");
    });

    it("returns markdown summary of recent cycles", () => {
      insertCycle(db, {
        cycleNumber: 1, preflightPassed: true, improvementsAttempted: 1,
        improvementsSucceeded: 1, buildVerificationPassed: true,
        pushSucceeded: true, testCountBefore: null, testCountAfter: null,
      });
      insertJournalEntry(db, 1, "attempted", "Did something");
      insertJournalEntry(db, 1, "succeeded", "It worked");

      const summary = getRecentJournalSummary(db);
      expect(summary).toContain("Cycle 1");
      expect(summary).toContain("Did something");
      expect(summary).toContain("It worked");
    });
  });

  describe("insertPhaseUsage", () => {
    it("inserts usage data", () => {
      insertCycle(db, {
        cycleNumber: 1, preflightPassed: true, improvementsAttempted: 0,
        improvementsSucceeded: 0, buildVerificationPassed: false,
        pushSucceeded: false, testCountBefore: null, testCountAfter: null,
      });
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
      insertCycle(db, {
        cycleNumber: 1, preflightPassed: true, improvementsAttempted: 0,
        improvementsSucceeded: 0, buildVerificationPassed: false,
        pushSucceeded: false, testCountBefore: null, testCountAfter: null,
      });
      insertIssueAction(db, 1, 42, "acknowledged");

      const rows = db.prepare("SELECT * FROM issue_actions WHERE cycle_number = 1").all();
      expect(rows).toHaveLength(1);
    });

    it("returns false when no action exists", () => {
      expect(hasIssueAction(db, 42, "acknowledged")).toBe(false);
    });

    it("returns true when action exists", () => {
      insertCycle(db, {
        cycleNumber: 1, preflightPassed: true, improvementsAttempted: 0,
        improvementsSucceeded: 0, buildVerificationPassed: false,
        pushSucceeded: false, testCountBefore: null, testCountAfter: null,
      });
      insertIssueAction(db, 1, 42, "acknowledged");
      expect(hasIssueAction(db, 42, "acknowledged")).toBe(true);
    });

    it("distinguishes between different actions", () => {
      insertCycle(db, {
        cycleNumber: 1, preflightPassed: true, improvementsAttempted: 0,
        improvementsSucceeded: 0, buildVerificationPassed: false,
        pushSucceeded: false, testCountBefore: null, testCountAfter: null,
      });
      insertIssueAction(db, 1, 42, "acknowledged");
      expect(hasIssueAction(db, 42, "acknowledged")).toBe(true);
      expect(hasIssueAction(db, 42, "closed")).toBe(false);
    });

    it("distinguishes between different issue numbers", () => {
      insertCycle(db, {
        cycleNumber: 1, preflightPassed: true, improvementsAttempted: 0,
        improvementsSucceeded: 0, buildVerificationPassed: false,
        pushSucceeded: false, testCountBefore: null, testCountAfter: null,
      });
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
    });

    it("computes correct success rate", () => {
      // 2 successful, 1 failed = 67%
      insertCycle(db, {
        cycleNumber: 1, preflightPassed: true, improvementsAttempted: 2,
        improvementsSucceeded: 2, buildVerificationPassed: true,
        pushSucceeded: true, testCountBefore: 100, testCountAfter: 105,
      });
      insertCycle(db, {
        cycleNumber: 2, preflightPassed: true, improvementsAttempted: 1,
        improvementsSucceeded: 0, buildVerificationPassed: false,
        pushSucceeded: false, testCountBefore: 105, testCountAfter: null,
      });
      insertCycle(db, {
        cycleNumber: 3, preflightPassed: true, improvementsAttempted: 3,
        improvementsSucceeded: 3, buildVerificationPassed: true,
        pushSucceeded: true, testCountBefore: 105, testCountAfter: 115,
      });

      const stats = getCycleStats(db);
      expect(stats.totalCycles).toBe(3);
      expect(stats.successRate).toBe(67);
      expect(stats.avgImprovements).toBe(1.7); // (2+0+3)/3 = 1.666... rounds to 1.7
      expect(stats.recentFailures).toBe(1);
    });

    it("computes test count trend from oldest to newest", () => {
      insertCycle(db, {
        cycleNumber: 1, preflightPassed: true, improvementsAttempted: 1,
        improvementsSucceeded: 1, buildVerificationPassed: true,
        pushSucceeded: true, testCountBefore: 100, testCountAfter: 110,
      });
      insertCycle(db, {
        cycleNumber: 2, preflightPassed: true, improvementsAttempted: 1,
        improvementsSucceeded: 1, buildVerificationPassed: true,
        pushSucceeded: true, testCountBefore: 110, testCountAfter: 130,
      });

      const stats = getCycleStats(db);
      // newest after (130) - oldest before (100) = 30
      expect(stats.testCountTrend).toBe(30);
    });

    it("respects limit parameter", () => {
      for (let i = 1; i <= 10; i++) {
        insertCycle(db, {
          cycleNumber: i, preflightPassed: true, improvementsAttempted: 1,
          improvementsSucceeded: 1, buildVerificationPassed: true,
          pushSucceeded: true, testCountBefore: null, testCountAfter: null,
        });
      }

      const stats = getCycleStats(db, 3);
      expect(stats.totalCycles).toBe(3);
    });
  });

  describe("formatCycleStats", () => {
    it("returns message when no data", () => {
      const result = formatCycleStats({
        totalCycles: 0, successRate: 0, avgImprovements: 0,
        testCountTrend: null, recentFailures: 0,
      });
      expect(result).toBe("No previous cycle data available.");
    });

    it("includes all metrics when data exists", () => {
      const result = formatCycleStats({
        totalCycles: 10, successRate: 80, avgImprovements: 1.5,
        testCountTrend: 42, recentFailures: 1,
      });
      expect(result).toContain("10");
      expect(result).toContain("80%");
      expect(result).toContain("1.5");
      expect(result).toContain("+42");
      expect(result).toContain("1");
    });
  });
});
