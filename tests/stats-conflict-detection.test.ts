/**
 * Tests for the detectConflictingFilters helper in stats.ts.
 * Verifies that combining --last and --since produces a user-visible warning
 * string, and that each flag alone does not.
 */
import { describe, it, expect } from "vitest";
import { detectConflictingFilters } from "../src/stats.js";

describe("detectConflictingFilters", () => {
  it("returns null when only lastN is set", () => {
    expect(detectConflictingFilters(10, undefined)).toBeNull();
  });

  it("returns null when only sinceN is set", () => {
    expect(detectConflictingFilters(undefined, 700)).toBeNull();
  });

  it("returns null when neither is set", () => {
    expect(detectConflictingFilters(undefined, undefined)).toBeNull();
  });

  it("returns null when called with no arguments", () => {
    expect(detectConflictingFilters()).toBeNull();
  });

  it("returns a string when both lastN and sinceN are set", () => {
    const result = detectConflictingFilters(5, 700);
    expect(typeof result).toBe("string");
    expect(result).not.toBeNull();
  });

  it("warning string contains '--last' flag name", () => {
    const result = detectConflictingFilters(5, 700);
    expect(result).toContain("--last");
  });

  it("warning string contains '--since' flag name", () => {
    const result = detectConflictingFilters(5, 700);
    expect(result).toContain("--since");
  });

  it("warning string includes the sinceN value", () => {
    const result = detectConflictingFilters(5, 700);
    expect(result).toContain("700");
  });

  it("warning string includes the lastN value", () => {
    const result = detectConflictingFilters(5, 700);
    expect(result).toContain("5");
  });

  it("warning differs when different values are supplied", () => {
    const a = detectConflictingFilters(3, 100);
    const b = detectConflictingFilters(10, 500);
    expect(a).not.toBe(b);
  });
});
