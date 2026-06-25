/**
 * Tests for withRoadmapItems write-skip optimization.
 * Verifies that writeRoadmap is NOT called when the roadmap items are unchanged
 * (e.g., no-op operations like updating a non-existent ID or adding a duplicate).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  it("emits console.warn with tag and char counts when addLinkedItem truncates body", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([]), "utf-8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    addLinkedItem(config, 99, "Warn test", longBody);

    expect(warnSpy).toHaveBeenCalledOnce();
    const warnArg: string = warnSpy.mock.calls[0][0];
    expect(warnArg).toContain("addLinkedItem #99");
    expect(warnArg).toContain("600");
    expect(warnArg).toContain("500");

    warnSpy.mockRestore();
  });

  it("emits console.warn with tag and char counts when addDraftItem truncates body", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([]), "utf-8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    addDraftItem(config, "Warn draft", longBody);

    expect(warnSpy).toHaveBeenCalledOnce();
    const warnArg: string = warnSpy.mock.calls[0][0];
    expect(warnArg).toContain('addDraftItem "Warn draft"');
    expect(warnArg).toContain("600");
    expect(warnArg).toContain("500");

    warnSpy.mockRestore();
  });

  it("does NOT emit console.warn when body is within the limit", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([]), "utf-8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    addLinkedItem(config, 200, "No warn test", "Short body");

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("truncates completionNote in updateItemStatus Done and appends truncation indicator", () => {
    const item = makeItem({ id: "item-0", title: "Work item", status: "In Progress" });
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([item]), "utf-8");

    const longNote = "z".repeat(600);
    updateItemStatus(config, "item-0", "Done", longNote);

    const written = readFileSync(join(tmpDir, "ROADMAP.md"), "utf-8");
    const items = parseRoadmap(written);
    expect(items[0].status).toBe("Done");
    expect(items[0].body.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    expect(items[0].body.startsWith("z".repeat(500))).toBe(true);
  });

  it("does NOT truncate completionNote in updateItemStatus Done when within limit", () => {
    const item = makeItem({ id: "item-0", title: "Work item", status: "In Progress" });
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([item]), "utf-8");

    const shortNote = "Completed successfully.";
    updateItemStatus(config, "item-0", "Done", shortNote);

    const written = readFileSync(join(tmpDir, "ROADMAP.md"), "utf-8");
    const items = parseRoadmap(written);
    expect(items[0].status).toBe("Done");
    expect(items[0].body).toBe(shortNote);
  });
});

describe("CRLF normalization in updateItemStatus", () => {
  it("normalizes \\r\\n to \\n in completionNote before storing", () => {
    const item = makeItem({ id: "item-0", title: "Work item", status: "In Progress" });
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([item]), "utf-8");

    const crlfNote = "Line one\r\nLine two\r\nLine three";
    updateItemStatus(config, "item-0", "Done", crlfNote);

    const written = readFileSync(join(tmpDir, "ROADMAP.md"), "utf-8");
    const items = parseRoadmap(written);
    expect(items[0].status).toBe("Done");
    expect(items[0].body).not.toContain("\r");
    expect(items[0].body).toContain("Line one\nLine two\nLine three");
  });
});

describe("CRLF normalization in addLinkedItem and addDraftItem", () => {
  it("normalizes \\r\\n to \\n in addLinkedItem body before storing", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([]), "utf-8");

    const crlfBody = "First line\r\nSecond line\r\nThird line";
    addLinkedItem(config, 55, "CRLF test", crlfBody);

    const written = readFileSync(join(tmpDir, "ROADMAP.md"), "utf-8");
    const items = parseRoadmap(written);
    expect(items[0].body).not.toContain("\r");
    expect(items[0].body).toContain("First line\nSecond line\nThird line");
  });

  it("normalizes \\r\\n to \\n in addDraftItem body before storing", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), serializeRoadmap([]), "utf-8");

    const crlfBody = "Alpha\r\nBeta\r\nGamma";
    addDraftItem(config, "CRLF draft test", crlfBody);

    const written = readFileSync(join(tmpDir, "ROADMAP.md"), "utf-8");
    const items = parseRoadmap(written);
    expect(items[0].body).not.toContain("\r");
    expect(items[0].body).toContain("Alpha\nBeta\nGamma");
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
