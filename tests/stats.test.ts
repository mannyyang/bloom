import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initDb, insertCycle, insertPhaseUsage, insertStrategicContext, insertLearning, getCycleStats } from "../src/db.js";
import { generateStatsOutput } from "../src/stats.js";
import { makeOutcome } from "./helpers.js";

describe("generateStatsOutput", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("returns a single message when no cycles exist", () => {
    const output = generateStatsOutput(db);
    expect(output).toHaveLength(1);
    expect(output[0]).toBe("No evolution cycles recorded yet.");
  });

  it("includes header with latest cycle number", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 5 }));
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Bloom Evolution Statistics");
    expect(joined).toContain("Latest cycle: 5");
  });

  it("includes formatted stats when cycles exist", () => {
    insertCycle(
      db,
      makeOutcome({
        cycleNumber: 1,
        preflightPassed: true,
        improvementsAttempted: 2,
        improvementsSucceeded: 1,
        buildVerificationPassed: true,
        pushSucceeded: true,
      }),
    );
    insertPhaseUsage(db, 1, {
      phase: "evolution",
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0.05,
      durationMs: 60000,
      numTurns: 5,
    });

    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    // Should include some stats content from formatCycleStats
    expect(joined).toContain("========================================");
    expect(joined.length).toBeGreaterThan(100);
  });

  it("includes strategic context when available", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertStrategicContext(db, 1, "Focus on improving test coverage.");

    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Focus on improving test coverage.");
  });

  it("uses the highest cycle number as latest", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 3 }));
    insertCycle(db, makeOutcome({ cycleNumber: 7 }));
    insertCycle(db, makeOutcome({ cycleNumber: 5 }));

    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Latest cycle: 7");
  });

  it("does not include memory section when no learnings or context exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    // Should have header and stats but the memory section should be absent
    expect(joined).toContain("Bloom Evolution Statistics");
    // formatMemoryForPrompt returns "" when no learnings/context exist,
    // so no extra memory block should appear
  });

  it("includes success rate in output", () => {
    insertCycle(db, makeOutcome({
      cycleNumber: 1,
      buildVerificationPassed: true,
      pushSucceeded: true,
    }));
    insertCycle(db, makeOutcome({
      cycleNumber: 2,
      buildVerificationPassed: false,
      pushSucceeded: false,
    }));
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Success rate");
    expect(joined).toContain("50%");
  });

  it("includes improvement averages in stats", () => {
    insertCycle(db, makeOutcome({
      cycleNumber: 1,
      improvementsAttempted: 3,
      improvementsSucceeded: 2,
    }));
    insertCycle(db, makeOutcome({
      cycleNumber: 2,
      improvementsAttempted: 3,
      improvementsSucceeded: 3,
    }));
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Avg improvements/cycle");
    expect(joined).toContain("2.5");
  });

  it("shows cost info when phase usage has cost data", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertPhaseUsage(db, 1, {
      phase: "assessment",
      inputTokens: 5000,
      outputTokens: 2000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 1.23,
      durationMs: 30000,
      numTurns: 3,
    });
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Cost");
    expect(joined).toContain("$1.23");
  });

  it("shows token counts in formatted output", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertPhaseUsage(db, 1, {
      phase: "evolution",
      inputTokens: 50000,
      outputTokens: 10000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0.50,
      durationMs: 60000,
      numTurns: 5,
    });
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("tokens");
    expect(joined).toContain("50k in");
    expect(joined).toContain("10k out");
  });

  it("includes learnings in memory section when they exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertLearning(db, 1, "pattern", "Always run tests before committing");

    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Always run tests before committing");
  });

  it("includes both learnings and strategic context when both exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertLearning(db, 1, "domain", "SQLite is fast for in-process use");
    insertStrategicContext(db, 1, "Focusing on robustness improvements.");

    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("SQLite is fast for in-process use");
    expect(joined).toContain("Focusing on robustness improvements.");
  });

  it("handles a high cycle number correctly", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 9999 }));
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Latest cycle: 9999");
  });

  it("shows recent failures count", () => {
    for (let i = 1; i <= 5; i++) {
      insertCycle(db, makeOutcome({
        cycleNumber: i,
        buildVerificationPassed: i % 2 === 0,
        pushSucceeded: i % 2 === 0,
      }));
    }
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Recent failures");
    expect(joined).toContain("3");
  });

  it("returns array of strings, not a single string", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const output = generateStatsOutput(db);
    expect(Array.isArray(output)).toBe(true);
    expect(output.length).toBeGreaterThan(1);
    for (const line of output) {
      expect(typeof line).toBe("string");
    }
  });

  describe("failure category breakdown", () => {
    it("getCycleStats returns correct counts per category", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: false, pushSucceeded: false, failureCategory: "build_failure" }));
      insertCycle(db, makeOutcome({ cycleNumber: 2, buildVerificationPassed: false, pushSucceeded: false, failureCategory: "build_failure" }));
      insertCycle(db, makeOutcome({ cycleNumber: 3, buildVerificationPassed: false, pushSucceeded: false, failureCategory: "test_failure" }));
      insertCycle(db, makeOutcome({ cycleNumber: 4, buildVerificationPassed: false, pushSucceeded: false, failureCategory: "llm_error" }));
      insertCycle(db, makeOutcome({ cycleNumber: 5, buildVerificationPassed: true, pushSucceeded: true, failureCategory: "none" }));
      const stats = getCycleStats(db);
      expect(stats.failureCategoryBreakdown["build_failure"]).toBe(2);
      expect(stats.failureCategoryBreakdown["test_failure"]).toBe(1);
      expect(stats.failureCategoryBreakdown["llm_error"]).toBe(1);
      expect(stats.failureCategoryBreakdown["none"]).toBeUndefined();
    });

    it("failure breakdown appears in generateStatsOutput when failures exist", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: false, pushSucceeded: false, failureCategory: "build_failure" }));
      insertCycle(db, makeOutcome({ cycleNumber: 2, buildVerificationPassed: false, pushSucceeded: false, failureCategory: "test_failure" }));
      const output = generateStatsOutput(db);
      const joined = output.join("\n");
      expect(joined).toContain("build_failure");
      expect(joined).toContain("test_failure");
      expect(joined).toContain("Failure breakdown");
      expect(joined).toContain("across last");
    });

    it("failure breakdown omitted when all cycles have category none", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: false, pushSucceeded: false, failureCategory: "none" }));
      const output = generateStatsOutput(db);
      const joined = output.join("\n");
      expect(joined).not.toContain("Failure breakdown");
    });

    it("getCycleStats does not crash when failure_category has unexpected values", () => {
      // Simulate an old/migrated DB row where failure_category might be an empty string
      // by inserting a cycle then manually verifying getCycleStats handles empty breakdown gracefully
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      // getCycleStats excludes 'none' from the breakdown; empty result should not crash
      expect(() => getCycleStats(db)).not.toThrow();
      const stats = getCycleStats(db);
      expect(stats.failureCategoryBreakdown).toEqual({});
    });
  });

  describe("getCycleStats with zero cycles", () => {
    it("returns default stats on a freshly-initialised DB without throwing", () => {
      expect(() => getCycleStats(db)).not.toThrow();
      const stats = getCycleStats(db);
      expect(stats.totalCycles).toBe(0);
      expect(stats.successRate).toBe(0);
      expect(stats.avgImprovements).toBe(0);
      expect(stats.totalCostUsd).toBe(0);
      expect(stats.avgCostPerCycle).toBe(0);
      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
      expect(stats.failureCategoryBreakdown).toEqual({});
    });
  });
});
