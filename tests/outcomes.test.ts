import { describe, it, expect, afterEach } from "vitest";
import { unlinkSync, writeFileSync } from "fs";
import {
  parseTestCount,
  createOutcome,
  formatOutcomeForJournal,
  loadOutcomes,
  persistOutcome,
  CycleOutcome,
} from "../src/outcomes.js";

describe("parseTestCount", () => {
  it("parses vitest output with passed count", () => {
    expect(parseTestCount("Tests  490 passed")).toBe(490);
  });

  it("parses from multiline vitest output", () => {
    const output = `
 Test Files  7 passed (7)
      Tests  490 passed (490)
   Start at  19:02:38
`;
    expect(parseTestCount(output)).toBe(490);
  });

  it("returns null when no match found", () => {
    expect(parseTestCount("no test output here")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseTestCount("")).toBeNull();
  });

  it("parses single-digit count", () => {
    expect(parseTestCount("Tests  3 passed")).toBe(3);
  });

  it("parses large count", () => {
    expect(parseTestCount("Tests  1234 passed")).toBe(1234);
  });
});

describe("createOutcome", () => {
  it("creates a default outcome for a given cycle", () => {
    const outcome = createOutcome(42);
    expect(outcome.cycleNumber).toBe(42);
    expect(outcome.preflightPassed).toBe(false);
    expect(outcome.improvementsAttempted).toBe(0);
    expect(outcome.improvementsSucceeded).toBe(0);
    expect(outcome.buildVerificationPassed).toBe(false);
    expect(outcome.pushSucceeded).toBe(false);
    expect(outcome.testCountBefore).toBeNull();
    expect(outcome.testCountAfter).toBeNull();
  });
});

describe("formatOutcomeForJournal", () => {
  it("formats a fully successful outcome", () => {
    const outcome: CycleOutcome = {
      cycleNumber: 46,
      preflightPassed: true,
      improvementsAttempted: 3,
      improvementsSucceeded: 3,
      buildVerificationPassed: true,
      pushSucceeded: true,
      testCountBefore: 490,
      testCountAfter: 505,
    };
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("### Outcome Metrics");
    expect(result).toContain("**Preflight**: passed");
    expect(result).toContain("**Improvements**: 3/3 succeeded");
    expect(result).toContain("**Build verification**: passed");
    expect(result).toContain("**Push**: succeeded");
    expect(result).toContain("**Tests**: 490 before, 505 after (+15)");
  });

  it("formats a partially failed outcome", () => {
    const outcome: CycleOutcome = {
      cycleNumber: 46,
      preflightPassed: true,
      improvementsAttempted: 3,
      improvementsSucceeded: 1,
      buildVerificationPassed: false,
      pushSucceeded: false,
      testCountBefore: 490,
      testCountAfter: 490,
    };
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("**Improvements**: 1/3 succeeded");
    expect(result).toContain("**Build verification**: failed");
    expect(result).toContain("**Push**: failed");
    expect(result).toContain("(+0)");
  });

  it("formats outcome with negative test delta", () => {
    const outcome: CycleOutcome = {
      cycleNumber: 10,
      preflightPassed: true,
      improvementsAttempted: 1,
      improvementsSucceeded: 0,
      buildVerificationPassed: true,
      pushSucceeded: true,
      testCountBefore: 100,
      testCountAfter: 95,
    };
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("(-5)");
  });

  it("handles null testCountBefore", () => {
    const outcome: CycleOutcome = {
      cycleNumber: 1,
      preflightPassed: true,
      improvementsAttempted: 1,
      improvementsSucceeded: 1,
      buildVerificationPassed: true,
      pushSucceeded: true,
      testCountBefore: null,
      testCountAfter: 50,
    };
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("50 after (before count unavailable)");
  });

  it("handles null testCountAfter", () => {
    const outcome: CycleOutcome = {
      cycleNumber: 1,
      preflightPassed: true,
      improvementsAttempted: 1,
      improvementsSucceeded: 1,
      buildVerificationPassed: true,
      pushSucceeded: true,
      testCountBefore: 50,
      testCountAfter: null,
    };
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("50 before (after count unavailable)");
  });

  it("handles both test counts null", () => {
    const outcome: CycleOutcome = {
      cycleNumber: 1,
      preflightPassed: false,
      improvementsAttempted: 0,
      improvementsSucceeded: 0,
      buildVerificationPassed: false,
      pushSucceeded: false,
      testCountBefore: null,
      testCountAfter: null,
    };
    const result = formatOutcomeForJournal(outcome);
    expect(result).not.toContain("**Tests**");
  });

  it("includes section header", () => {
    const outcome = createOutcome(1);
    const result = formatOutcomeForJournal(outcome);
    expect(result.startsWith("### Outcome Metrics")).toBe(true);
  });
});

describe("loadOutcomes", () => {
  const testPath = "test-metrics-load.json";

  afterEach(() => {
    try { unlinkSync(testPath); } catch { /* ignore */ }
  });

  it("returns empty array when file does not exist", () => {
    expect(loadOutcomes(testPath)).toEqual([]);
  });

  it("returns empty array when file contains invalid JSON", () => {
    writeFileSync(testPath, "not json", "utf-8");
    expect(loadOutcomes(testPath)).toEqual([]);
  });

  it("returns empty array when file contains a non-array JSON value", () => {
    writeFileSync(testPath, '{"key": "value"}', "utf-8");
    expect(loadOutcomes(testPath)).toEqual([]);
  });

  it("loads an array of outcomes from file", () => {
    const outcomes = [createOutcome(1), createOutcome(2)];
    writeFileSync(testPath, JSON.stringify(outcomes), "utf-8");
    expect(loadOutcomes(testPath)).toEqual(outcomes);
  });
});

describe("persistOutcome", () => {
  const testPath = "test-metrics-persist.json";

  afterEach(() => {
    try { unlinkSync(testPath); } catch { /* ignore */ }
  });

  it("creates file with single outcome when file does not exist", () => {
    const outcome = createOutcome(1);
    outcome.preflightPassed = true;
    persistOutcome(outcome, testPath);
    const loaded = loadOutcomes(testPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].cycleNumber).toBe(1);
    expect(loaded[0].preflightPassed).toBe(true);
  });

  it("appends to existing outcomes", () => {
    persistOutcome(createOutcome(1), testPath);
    persistOutcome(createOutcome(2), testPath);
    const loaded = loadOutcomes(testPath);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].cycleNumber).toBe(1);
    expect(loaded[1].cycleNumber).toBe(2);
  });

  it("writes valid JSON with trailing newline", () => {
    persistOutcome(createOutcome(5), testPath);
    const raw = require("fs").readFileSync(testPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
