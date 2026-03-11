import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { ensureProject, getProjectItems, addDraftItem, addLinkedItem, updateItemStatus, type ProjectConfig } from "../src/planning.js";

const ROADMAP_PATH = resolve(process.cwd(), "ROADMAP.md");

function makeConfig(): ProjectConfig {
  return { filePath: ROADMAP_PATH };
}

function writeTestRoadmap(content: string): void {
  writeFileSync(ROADMAP_PATH, content, "utf-8");
}

function readTestRoadmap(): string {
  return readFileSync(ROADMAP_PATH, "utf-8");
}

// Save and restore the original ROADMAP.md if it exists
let originalContent: string | null = null;

beforeEach(() => {
  if (existsSync(ROADMAP_PATH)) {
    originalContent = readFileSync(ROADMAP_PATH, "utf-8");
  } else {
    originalContent = null;
  }
});

afterEach(() => {
  if (originalContent !== null) {
    writeFileSync(ROADMAP_PATH, originalContent, "utf-8");
  } else if (existsSync(ROADMAP_PATH)) {
    unlinkSync(ROADMAP_PATH);
  }
});

describe("ensureProject", () => {
  it("creates ROADMAP.md if it does not exist", () => {
    if (existsSync(ROADMAP_PATH)) unlinkSync(ROADMAP_PATH);

    const config = ensureProject();
    expect(config).not.toBeNull();
    expect(config!.filePath).toBe(ROADMAP_PATH);
    expect(existsSync(ROADMAP_PATH)).toBe(true);
    const content = readTestRoadmap();
    expect(content).toContain("# Bloom Evolution Roadmap");
  });

  it("returns config if ROADMAP.md already exists", () => {
    writeTestRoadmap("# Bloom Evolution Roadmap\n\n## Backlog\n- [ ] Existing item\n");

    const config = ensureProject();
    expect(config).not.toBeNull();
    // Should not overwrite existing content
    const content = readTestRoadmap();
    expect(content).toContain("Existing item");
  });
});

describe("getProjectItems", () => {
  it("returns parsed items from ROADMAP.md", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] Fix bug (#42)
  Description here

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const items = getProjectItems(config);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Fix bug");
    expect(items[0].linkedIssueNumber).toBe(42);
    expect(items[0].status).toBe("Backlog");
    expect(items[0].body).toBe("Description here");
  });

  it("returns empty array when roadmap has no items", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Done
`);
    const config = makeConfig();
    const items = getProjectItems(config);
    expect(items).toEqual([]);
  });
});

describe("addDraftItem", () => {
  it("adds a draft item to the roadmap", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const itemId = addDraftItem(config, "New feature", "Details", "Up Next");
    expect(itemId).not.toBeNull();

    const content = readTestRoadmap();
    expect(content).toContain("- [ ] New feature");
    expect(content).toContain("  Details");
  });

  it("defaults to Backlog status", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    addDraftItem(config, "Title", "Body");

    const items = getProjectItems(config);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("Backlog");
  });
});

describe("addLinkedItem", () => {
  it("adds an issue-linked item to the roadmap", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const itemId = addLinkedItem(config, "owner/repo", 42, "Fix bug", "Description");
    expect(itemId).not.toBeNull();

    const content = readTestRoadmap();
    expect(content).toContain("- [ ] Fix bug (#42)");
  });

  it("does not add duplicate issue numbers", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] Fix bug (#42)

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    addLinkedItem(config, "owner/repo", 42, "Fix bug", "Description");

    const items = getProjectItems(config);
    const issue42Items = items.filter((i) => i.linkedIssueNumber === 42);
    expect(issue42Items).toHaveLength(1);
  });
});

describe("updateItemStatus", () => {
  it("updates an item's status", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] My task

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    let items = getProjectItems(config);
    expect(items[0].status).toBe("Backlog");

    const result = updateItemStatus(config, items[0].id, "In Progress");
    expect(result).toBe(true);

    items = getProjectItems(config);
    expect(items[0].status).toBe("In Progress");
  });

  it("returns false for non-existent item", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Done
`);
    const config = makeConfig();
    const result = updateItemStatus(config, "nonexistent", "Done");
    expect(result).toBe(false);
  });

  it("marks Done items with [x]", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] Complete me

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const items = getProjectItems(config);
    updateItemStatus(config, items[0].id, "Done");

    const content = readTestRoadmap();
    expect(content).toContain("- [x] Complete me");
  });

  it("replaces body with completion note when moving to Done", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] Fix the bug (#5)
  Original description of the bug

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const items = getProjectItems(config);
    updateItemStatus(config, items[0].id, "Done", "Fixed in cycle 73: resolved the root cause.");

    const content = readTestRoadmap();
    expect(content).toContain("- [x] Fix the bug (#5)");
    expect(content).toContain("  Fixed in cycle 73: resolved the root cause.");
    expect(content).not.toContain("Original description of the bug");
  });

  it("preserves original body when no completion note is provided", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] Keep my body (#9)
  Important details

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const items = getProjectItems(config);
    updateItemStatus(config, items[0].id, "Done");

    const content = readTestRoadmap();
    expect(content).toContain("  Important details");
  });

  it("ignores completion note when status is not Done", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] Not done yet
  Original body

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const items = getProjectItems(config);
    updateItemStatus(config, items[0].id, "Up Next", "Should be ignored");

    const content = readTestRoadmap();
    const updatedItems = getProjectItems(config);
    expect(updatedItems[0].status).toBe("Up Next");
    expect(updatedItems[0].body).toBe("Original body");
  });
});
