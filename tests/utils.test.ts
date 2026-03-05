import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getDayCount, incrementDayCount } from "../src/utils.js";

describe("getDayCount", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bloom-utils-test-"));
    filePath = join(dir, "DAY_COUNT");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 0 when file does not exist", () => {
    expect(getDayCount(filePath)).toBe(0);
  });

  it("returns the correct count from a valid file", () => {
    writeFileSync(filePath, "7");
    expect(getDayCount(filePath)).toBe(7);
  });

  it("returns 0 for malformed file content", () => {
    writeFileSync(filePath, "abc");
    expect(getDayCount(filePath)).toBe(0);
  });

  it("returns 0 for an empty file", () => {
    writeFileSync(filePath, "");
    expect(getDayCount(filePath)).toBe(0);
  });
});

describe("incrementDayCount", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bloom-utils-test-"));
    filePath = join(dir, "DAY_COUNT");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("increments from 0 to 1 when file does not exist", () => {
    expect(incrementDayCount(filePath)).toBe(1);
  });

  it("increments by exactly 1 each call", () => {
    expect(incrementDayCount(filePath)).toBe(1);
    expect(incrementDayCount(filePath)).toBe(2);
    expect(incrementDayCount(filePath)).toBe(3);
  });

  it("persists the incremented value to disk", () => {
    incrementDayCount(filePath);
    incrementDayCount(filePath);
    expect(getDayCount(filePath)).toBe(2);
  });

  it("resumes correctly from an existing count", () => {
    writeFileSync(filePath, "10");
    expect(incrementDayCount(filePath)).toBe(11);
  });
});
