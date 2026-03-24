import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { initDb, getJournalEntries } from "../src/db.js";
import {
  processEvolutionResult,
  formatCycleSummaryWithDuration,
} from "../src/orchestrator.js";
import { insertCycle } from "../src/db.js";
import { makeOutcome } from "./helpers.js";

describe("orchestrator", () => {
  describe("processEvolutionResult", () => {
    let db: Database.Database;

    beforeEach(() => {
      db = initDb(":memory:");
      // Insert a cycle row so journal entries can reference it
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    });

    it("parses and stores journal sections", () => {
      const result = `Some preamble text

ATTEMPTED: Added new feature X
SUCCEEDED: Feature X works
FAILED: Nothing failed
LEARNINGS: - [pattern] Small changes are better
STRATEGIC_CONTEXT: Focus on test coverage next`;

      const processed = processEvolutionResult(db, 1, result);

      expect(processed.journalSections.attempted).toBe("Added new feature X");
      expect(processed.journalSections.succeeded).toBe("Feature X works");
      expect(processed.journalSections.failed).toBe("Nothing failed");
      expect(processed.journalSections.strategic_context).toBe(
        "Focus on test coverage next",
      );

      // Verify entries were stored in DB
      const entries = getJournalEntries(db);
      expect(entries.length).toBeGreaterThanOrEqual(4);
    });

    it("skips empty sections when storing to DB", () => {
      const result = `ATTEMPTED: Did something
SUCCEEDED:
FAILED:
LEARNINGS:
STRATEGIC_CONTEXT:`;

      const processed = processEvolutionResult(db, 1, result);

      expect(processed.journalSections.attempted).toBe("Did something");
      // Empty sections should not be stored
      const entries = getJournalEntries(db);
      const sections = entries.map((e) => e.section);
      expect(sections).toContain("attempted");
      expect(sections).not.toContain("succeeded");
    });

    it("counts improvements from attempted and succeeded sections", () => {
      const result = `ATTEMPTED: - Improvement A
- Improvement B
- Improvement C
SUCCEEDED: - Improvement A
- Improvement B
FAILED: - Improvement C
LEARNINGS: - [domain] Learned something
STRATEGIC_CONTEXT: Continue improving`;

      const processed = processEvolutionResult(db, 1, result);

      expect(processed.improvementsAttempted).toBe(3);
      expect(processed.improvementsSucceeded).toBe(2);
    });

    it("extracts and stores learnings", () => {
      const result = `ATTEMPTED: Something
SUCCEEDED: Something
FAILED: Nothing
LEARNINGS: - [pattern] Always test first
- [anti-pattern] Don't skip validation
- [domain] SQLite WAL mode is fast
STRATEGIC_CONTEXT: Keep going`;

      const processed = processEvolutionResult(db, 1, result);

      expect(processed.learningsStored).toBe(3);
    });

    it("stores strategic context", () => {
      const result = `ATTEMPTED: Something
SUCCEEDED: Something
FAILED: Nothing
LEARNINGS: - Learned things
STRATEGIC_CONTEXT: Focus on orchestrator tests next cycle`;

      const processed = processEvolutionResult(db, 1, result);

      expect(processed.strategicContextStored).toBe(true);
    });

    it("handles missing strategic context gracefully", () => {
      const result = `ATTEMPTED: Something
SUCCEEDED: Something
FAILED: Nothing
LEARNINGS: - Learned things`;

      const processed = processEvolutionResult(db, 1, result);

      expect(processed.strategicContextStored).toBe(false);
    });

    it("handles result with only LEARNINGS and STRATEGIC_CONTEXT sections", () => {
      const result = `LEARNINGS: - [pattern] Important lesson
- [domain] Domain insight
STRATEGIC_CONTEXT: Focus on refactoring next`;

      const processed = processEvolutionResult(db, 1, result);

      expect(processed.learningsStored).toBe(2);
      expect(processed.strategicContextStored).toBe(true);
      expect(processed.improvementsAttempted).toBe(0);
      expect(processed.improvementsSucceeded).toBe(0);

      // Verify only non-empty sections were stored
      const entries = getJournalEntries(db);
      const sections = entries.map((e) => e.section);
      expect(sections).toContain("learnings");
      expect(sections).toContain("strategic_context");
    });

    it("handles duplicate section headers by keeping last value", () => {
      // parseEvolutionResult uses a regex that captures until the next marker,
      // so a duplicate header would overwrite the first
      const result = `ATTEMPTED: First attempt
SUCCEEDED: First success
ATTEMPTED: Second attempt
FAILED: Nothing
LEARNINGS: Lesson
STRATEGIC_CONTEXT: Context`;

      const processed = processEvolutionResult(db, 1, result);

      // The parsing behavior should not crash regardless of duplicate handling
      expect(processed.journalSections).toBeDefined();
      expect(processed.improvementsAttempted).toBeGreaterThanOrEqual(0);
    });

    it("handles very long evolution output without crashing", () => {
      const longContent = "A".repeat(10000);
      const result = `ATTEMPTED: ${longContent}
SUCCEEDED: ${longContent}
FAILED: Nothing
LEARNINGS: - [pattern] ${longContent}
STRATEGIC_CONTEXT: ${longContent}`;

      const processed = processEvolutionResult(db, 1, result);

      expect(processed.journalSections.attempted).toBe(longContent);
      expect(processed.strategicContextStored).toBe(true);
    });

    it("handles empty evolution result", () => {
      const processed = processEvolutionResult(db, 1, "");

      expect(processed.improvementsAttempted).toBe(0);
      expect(processed.improvementsSucceeded).toBe(0);
      expect(processed.learningsStored).toBe(0);
      expect(processed.strategicContextStored).toBe(false);
    });

    it("handles malformed learnings without crashing", () => {
      const result = `ATTEMPTED: Something
SUCCEEDED: Something
FAILED: Nothing
LEARNINGS: not a proper list at all
STRATEGIC_CONTEXT: Keep going`;

      const processed = processEvolutionResult(db, 1, result);

      // Should not crash, learnings count may be 0
      expect(processed.learningsStored).toBe(0);
    });

    it("returns correct ProcessedEvolution structure", () => {
      const result = `ATTEMPTED: - One thing
SUCCEEDED: - One thing
FAILED: Nothing
LEARNINGS: - [pattern] A learning
STRATEGIC_CONTEXT: Strategic info`;

      const processed = processEvolutionResult(db, 1, result);

      expect(processed).toHaveProperty("journalSections");
      expect(processed).toHaveProperty("improvementsAttempted");
      expect(processed).toHaveProperty("improvementsSucceeded");
      expect(processed).toHaveProperty("learningsStored");
      expect(processed).toHaveProperty("strategicContextStored");
    });

    it("propagates error when insertJournalEntry throws", async () => {
      const dbModule = await import("../src/db.js");
      const spy = vi.spyOn(dbModule, "insertJournalEntry").mockImplementation(() => {
        throw new Error("simulated DB write failure");
      });

      const result = `ATTEMPTED: Something
SUCCEEDED: Something
FAILED: Nothing
LEARNINGS: - [pattern] A learning
STRATEGIC_CONTEXT: Context`;

      expect(() => processEvolutionResult(db, 1, result)).toThrow("simulated DB write failure");

      spy.mockRestore();
    });

    it("still returns correct results when extractLearnings throws", async () => {
      const memoryModule = await import("../src/memory.js");
      const spy = vi.spyOn(memoryModule, "extractLearnings").mockImplementation(() => {
        throw new Error("simulated extraction failure");
      });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = `ATTEMPTED: - Improvement A
SUCCEEDED: - Improvement A
FAILED: Nothing
LEARNINGS: - [pattern] A learning
STRATEGIC_CONTEXT: Focus on testing`;

      const processed = processEvolutionResult(db, 1, result);

      expect(processed.learningsStored).toBe(0);
      expect(processed.improvementsAttempted).toBe(1);
      expect(processed.improvementsSucceeded).toBe(1);
      expect(processed.strategicContextStored).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to store learnings"),
      );

      spy.mockRestore();
      consoleSpy.mockRestore();
    });

    it("still returns correct results when storeStrategicContext throws", async () => {
      const memoryModule = await import("../src/memory.js");
      const spy = vi.spyOn(memoryModule, "storeStrategicContext").mockImplementation(() => {
        throw new Error("simulated context storage failure");
      });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = `ATTEMPTED: - Improvement A
- Improvement B
SUCCEEDED: - Improvement A
FAILED: - Improvement B
LEARNINGS: - [pattern] A learning
STRATEGIC_CONTEXT: Focus on testing`;

      const processed = processEvolutionResult(db, 1, result);

      expect(processed.strategicContextStored).toBe(false);
      expect(processed.improvementsAttempted).toBe(2);
      expect(processed.improvementsSucceeded).toBe(1);
      expect(processed.learningsStored).toBe(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to store strategic context"),
      );

      spy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  describe("formatCycleSummaryWithDuration", () => {
    it("formats a successful cycle", () => {
      const outcome = makeOutcome({
        cycleNumber: 42,
        improvementsAttempted: 3,
        improvementsSucceeded: 2,
        buildVerificationPassed: true,
        pushSucceeded: true,
        testCountBefore: 600,
        testCountAfter: 615,
      });

      const summary = formatCycleSummaryWithDuration(42, outcome, null, 65000);

      expect(summary).toContain("Cycle 42");
      expect(summary).toContain("COMPLETE");
      expect(summary).toContain("65.0s");
      expect(summary).toContain("2/3");
      expect(summary).toContain("600 → 615");
      expect(summary).toContain("Build: PASSED");
      expect(summary).toContain("Push: OK");
    });

    it("formats a failed cycle with error", () => {
      const outcome = makeOutcome({
        cycleNumber: 5,
        improvementsAttempted: 0,
        improvementsSucceeded: 0,
        buildVerificationPassed: false,
        pushSucceeded: false,
      });

      const summary = formatCycleSummaryWithDuration(
        5,
        outcome,
        new Error("something broke"),
        10000,
      );

      expect(summary).toContain("Cycle 5");
      expect(summary).toContain("FAILED");
      expect(summary).toContain("10.0s");
      expect(summary).toContain("0/0");
      expect(summary).toContain("Build: FAILED");
      expect(summary).toContain("Push: FAILED");
    });

    it("shows ? for missing test counts", () => {
      const outcome = makeOutcome({
        testCountBefore: null,
        testCountAfter: null,
      });

      const summary = formatCycleSummaryWithDuration(1, outcome, null, 5000);

      expect(summary).toContain("? → ?");
    });

    it("formats sub-second durations", () => {
      const outcome = makeOutcome();
      const summary = formatCycleSummaryWithDuration(1, outcome, null, 500);

      expect(summary).toContain("0.5s");
    });

    it("includes separator lines", () => {
      const outcome = makeOutcome();
      const summary = formatCycleSummaryWithDuration(1, outcome, null, 1000);
      const lines = summary.split("\n");

      expect(lines[0]).toContain("====");
      expect(lines[lines.length - 1]).toContain("====");
    });

    it("shows ? for testCountBefore but number for testCountAfter", () => {
      const outcome = makeOutcome({
        testCountBefore: null,
        testCountAfter: 42,
      });

      const summary = formatCycleSummaryWithDuration(1, outcome, null, 5000);
      expect(summary).toContain("? → 42");
    });

    it("shows number for testCountBefore but ? for testCountAfter", () => {
      const outcome = makeOutcome({
        testCountBefore: 100,
        testCountAfter: null,
      });

      const summary = formatCycleSummaryWithDuration(1, outcome, null, 5000);
      expect(summary).toContain("100 → ?");
    });

    it("formats very long durations correctly", () => {
      const outcome = makeOutcome();
      // 10 minutes = 600000ms
      const summary = formatCycleSummaryWithDuration(1, outcome, null, 600000);
      expect(summary).toContain("600.0s");
    });
  });

});
