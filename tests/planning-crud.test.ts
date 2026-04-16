/**
 * Tests for withRoadmapItems write-skip optimization.
 * Verifies that writeRoadmap is NOT called when the roadmap items are unchanged
 * (e.g., no-op operations like updating a non-existent ID or adding a duplicate).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  updateItemStatus,
  addLinkedItem,
  addDraftItem,
  parseRoadmap,
  serializeRoadmap,
  type ProjectConfig,
  type ProjectItem,
} from "../src/planning.js";

const config: ProjectConfig = { filePath: "ROADMAP.md" };

let tmpDir: string;
let originalCwd: () => string;

function makeItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    id: "item-0",
    title: "Existing item",
    status: "Backlog",
    body: "",
    linkedIssueNumber: null,
    reactions: 0,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bloom-planning-test-"));
  // Redirect process.cwd() so getRoadmapPath() resolves into the temp dir
  originalCwd = process.cwd;
  process.cwd = () => tmpDir;
});

afterEach(() => {
  process.cwd = originalCwd;
});

describe("withRoadmapItems write-skip optimization", () => {
  it("does not update file mtime when updateItemStatus finds no matching ID", async () => {
    const items = [makeItem({ id: "item-0", title: "Alpha" })];
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap(items), "utf-8");

    // Wait a tick so any write would produce a different mtime
    await new Promise((r) => setTimeout(r, 5));
    const before = statSync(join(tmpDir, "ROADMAP.md")).mtimeMs;

    const result = updateItemStatus(config, "item-999", "Done");

    const after = statSync(join(tmpDir, "ROADMAP.md")).mtimeMs;
    expect(result).toBe(false);
    expect(after).toBe(before);
  });

  it("updates file mtime when updateItemStatus successfully changes an item", async () => {
    const items = [makeItem({ id: "item-0", title: "Alpha", status: "Backlog" })];
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap(items), "utf-8");

    await new Promise((r) => setTimeout(r, 5));
    const before = statSync(join(tmpDir, "ROADMAP.md")).mtimeMs;

    const result = updateItemStatus(config, "item-0", "Done");

    const after = statSync(join(tmpDir, "ROADMAP.md")).mtimeMs;
    expect(result).toBe(true);
    expect(after).toBeGreaterThan(before);
  });

  it("does not update file mtime when addLinkedItem finds a duplicate issue number", async () => {
    const items = [makeItem({ id: "item-0", linkedIssueNumber: 42, title: "Already linked" })];
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap(items), "utf-8");

    await new Promise((r) => setTimeout(r, 5));
    const before = statSync(join(tmpDir, "ROADMAP.md")).mtimeMs;

    const result = addLinkedItem(config, 42, "Duplicate title", "Body");

    const after = statSync(join(tmpDir, "ROADMAP.md")).mtimeMs;
    expect(result).toBe("item-0");
    expect(after).toBe(before);
  });

  it("updates file mtime when addLinkedItem adds a new item", async () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([]), "utf-8");

    await new Promise((r) => setTimeout(r, 5));
    const before = statSync(join(tmpDir, "ROADMAP.md")).mtimeMs;

    const result = addLinkedItem(config, 7, "New feature", "Body");

    const after = statSync(join(tmpDir, "ROADMAP.md")).mtimeMs;
    expect(result).toBe("item-0");
    expect(after).toBeGreaterThan(before);
  });
});

describe("body truncation at 500 chars", () => {
  const longBody = "x".repeat(600);
  const TRUNCATION_SUFFIX = " \u2026[truncated]";

  it("truncates addLinkedItem body and appends truncation indicator", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([]), "utf-8");

    addLinkedItem(config, 99, "Truncation test", longBody);

    const written = readFileSync(join(tmpDir, "ROADMAP.md"), "utf-8");
    const items = parseRoadmap(written);
    expect(items[0].body.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    expect(items[0].body.startsWith("x".repeat(500))).toBe(true);
  });

  it("truncates addDraftItem body and appends truncation indicator", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([]), "utf-8");

    addDraftItem(config, "Draft truncation test", longBody);

    const written = readFileSync(join(tmpDir, "ROADMAP.md"), "utf-8");
    const items = parseRoadmap(written);
    expect(items[0].body.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    expect(items[0].body.startsWith("x".repeat(500))).toBe(true);
  });

  it("does NOT append truncation indicator when body is within limit", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([]), "utf-8");

    const shortBody = "Short description";
    addLinkedItem(config, 100, "No truncation test", shortBody);

    const written = readFileSync(join(tmpDir, "ROADMAP.md"), "utf-8");
    const items = parseRoadmap(written);
    expect(items[0].body).toBe(shortBody);
    expect(items[0].body).not.toContain(TRUNCATION_SUFFIX);
  });

  it("does NOT append truncation indicator when body is exactly at the limit", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([]), "utf-8");

    const exactBody = "y".repeat(500);
    addLinkedItem(config, 101, "Exact limit test", exactBody);

    const written = readFileSync(join(tmpDir, "ROADMAP.md"), "utf-8");
    const items = parseRoadmap(written);
    expect(items[0].body).toBe(exactBody);
    expect(items[0].body).not.toContain(TRUNCATION_SUFFIX);
  });
});

describe("addDraftItem case-insensitive deduplication", () => {
  it("returns existing item id when title differs only by case", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([]), "utf-8");

    const firstId = addDraftItem(config, "Fix bug", "First body");
    const secondId = addDraftItem(config, "fix bug", "Second body");

    expect(secondId).toBe(firstId);
  });

  it("returns existing item id when title differs by leading/trailing whitespace", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([]), "utf-8");

    const firstId = addDraftItem(config, "Fix bug", "First body");
    const secondId = addDraftItem(config, "  Fix Bug  ", "Second body");

    expect(secondId).toBe(firstId);
  });

  it("creates a new item when titles are genuinely different", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([]), "utf-8");

    const firstId = addDraftItem(config, "Fix bug A", "Body");
    const secondId = addDraftItem(config, "Fix bug B", "Body");

    expect(secondId).not.toBe(firstId);
  });
});
