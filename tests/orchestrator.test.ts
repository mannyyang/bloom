import { describe, it, expect, beforeEach } from "vitest";
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
  });

});
