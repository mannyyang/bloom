import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getCycleCount, incrementCycleCount } from "../src/utils.js";

describe("getCycleCount", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bloom-utils-test-"));
    filePath = join(dir, "CYCLE_COUNT");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 0 when file does not exist", () => {
    expect(getCycleCount(filePath)).toBe(0);
  });

  it("returns the correct count from a valid file", () => {
    writeFileSync(filePath, "7");
    expect(getCycleCount(filePath)).toBe(7);
  });

  it("returns 0 for malformed file content", () => {
    writeFileSync(filePath, "abc");
    expect(getCycleCount(filePath)).toBe(0);
  });

  it("returns 0 for an empty file", () => {
    writeFileSync(filePath, "");
    expect(getCycleCount(filePath)).toBe(0);
  });
});

describe("incrementCycleCount", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bloom-utils-test-"));
    filePath = join(dir, "CYCLE_COUNT");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("increments from 0 to 1 when file does not exist", () => {
    expect(incrementCycleCount(filePath)).toBe(1);
  });

  it("increments by exactly 1 each call", () => {
    expect(incrementCycleCount(filePath)).toBe(1);
    expect(incrementCycleCount(filePath)).toBe(2);
    expect(incrementCycleCount(filePath)).toBe(3);
  });

  it("persists the incremented value to disk", () => {
    incrementCycleCount(filePath);
    incrementCycleCount(filePath);
    expect(getCycleCount(filePath)).toBe(2);
  });

  it("resumes correctly from an existing count", () => {
    writeFileSync(filePath, "10");
    expect(incrementCycleCount(filePath)).toBe(11);
  });
});
