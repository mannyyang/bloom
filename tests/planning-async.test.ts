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
  it("creates ROADMAP.md if it does not exist", async () => {
    if (existsSync(ROADMAP_PATH)) unlinkSync(ROADMAP_PATH);

    const config = await ensureProject();
    expect(config).not.toBeNull();
    expect(config!.filePath).toBe(ROADMAP_PATH);
    expect(existsSync(ROADMAP_PATH)).toBe(true);
    const content = readTestRoadmap();
    expect(content).toContain("# Bloom Evolution Roadmap");
  });

  it("returns config if ROADMAP.md already exists", async () => {
    writeTestRoadmap("# Bloom Evolution Roadmap\n\n## Backlog\n- [ ] Existing item\n");

    const config = await ensureProject();
    expect(config).not.toBeNull();
    // Should not overwrite existing content
    const content = readTestRoadmap();
    expect(content).toContain("Existing item");
  });
});

describe("getProjectItems", () => {
  it("returns parsed items from ROADMAP.md", async () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] Fix bug (#42)
  Description here

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const items = await getProjectItems(config);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Fix bug");
    expect(items[0].linkedIssueNumber).toBe(42);
    expect(items[0].status).toBe("Backlog");
    expect(items[0].body).toBe("Description here");
  });

  it("returns empty array when roadmap has no items", async () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Done
`);
    const config = makeConfig();
    const items = await getProjectItems(config);
    expect(items).toEqual([]);
  });
});

describe("addDraftItem", () => {
  it("adds a draft item to the roadmap", async () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const itemId = await addDraftItem(config, "New feature", "Details", "Up Next");
    expect(itemId).not.toBeNull();

    const content = readTestRoadmap();
    expect(content).toContain("- [ ] New feature");
    expect(content).toContain("  Details");
  });

  it("defaults to Backlog status", async () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    await addDraftItem(config, "Title", "Body");

    const items = await getProjectItems(config);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("Backlog");
  });
});

describe("addLinkedItem", () => {
  it("adds an issue-linked item to the roadmap", async () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const itemId = await addLinkedItem(config, "owner/repo", 42, "Fix bug", "Description");
    expect(itemId).not.toBeNull();

    const content = readTestRoadmap();
    expect(content).toContain("- [ ] Fix bug (#42)");
  });

  it("does not add duplicate issue numbers", async () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] Fix bug (#42)

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    await addLinkedItem(config, "owner/repo", 42, "Fix bug", "Description");

    const items = await getProjectItems(config);
    const issue42Items = items.filter((i) => i.linkedIssueNumber === 42);
    expect(issue42Items).toHaveLength(1);
  });
});

describe("updateItemStatus", () => {
  it("updates an item's status", async () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] My task

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    let items = await getProjectItems(config);
    expect(items[0].status).toBe("Backlog");

    const result = await updateItemStatus(config, items[0].id, "In Progress");
    expect(result).toBe(true);

    items = await getProjectItems(config);
    expect(items[0].status).toBe("In Progress");
  });

  it("returns false for non-existent item", async () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Done
`);
    const config = makeConfig();
    const result = await updateItemStatus(config, "nonexistent", "Done");
    expect(result).toBe(false);
  });

  it("marks Done items with [x]", async () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] Complete me

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const items = await getProjectItems(config);
    await updateItemStatus(config, items[0].id, "Done");

    const content = readTestRoadmap();
    expect(content).toContain("- [x] Complete me");
  });
});
