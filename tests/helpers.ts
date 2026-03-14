import type { CycleOutcome } from "../src/outcomes.js";

/**
 * Create a CycleOutcome with sensible defaults, overriding only the fields
 * that matter for a given test. Cuts boilerplate in db.test.ts and outcomes.test.ts.
 */
export function makeOutcome(overrides: Partial<CycleOutcome> = {}): CycleOutcome {
  return {
    cycleNumber: 1,
    preflightPassed: true,
    improvementsAttempted: 0,
    improvementsSucceeded: 0,
    buildVerificationPassed: false,
    pushSucceeded: false,
    testCountBefore: null,
    testCountAfter: null,
    testTotalBefore: null,
    testTotalAfter: null,
    durationMs: null,
    ...overrides,
  };
}
