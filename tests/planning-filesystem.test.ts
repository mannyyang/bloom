import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { ensureProject, getProjectItems, addDraftItem, addLinkedItem, updateItemStatus, demoteStaleInProgressItems, readRoadmap, type ProjectConfig } from "../src/planning.js";

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

describe("readRoadmap", () => {
  it("returns empty string when file does not exist", () => {
    if (existsSync(ROADMAP_PATH)) unlinkSync(ROADMAP_PATH);
    expect(readRoadmap(ROADMAP_PATH)).toBe("");
  });

  it("reads content from an explicit file path", () => {
    const content = "# Bloom Evolution Roadmap\n\n## Backlog\n";
    writeFileSync(ROADMAP_PATH, content, "utf-8");
    expect(readRoadmap(ROADMAP_PATH)).toBe(content);
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

  it("does not add duplicate titles", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] Existing feature
  Some body

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const existingId = addDraftItem(config, "Existing feature", "Different body");
    expect(existingId).not.toBeNull();

    const items = getProjectItems(config);
    const matching = items.filter((i) => i.title === "Existing feature");
    expect(matching).toHaveLength(1);
    // Body should remain unchanged (original not overwritten)
    expect(matching[0].body).toBe("Some body");
  });

  it("returns existing item ID when duplicate title is added", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] My task

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const items = getProjectItems(config);
    const originalId = items[0].id;

    const returnedId = addDraftItem(config, "My task", "New body");
    expect(returnedId).toBe(originalId);
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
    const itemId = addLinkedItem(config, 42, "Fix bug", "Description");
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
    addLinkedItem(config, 42, "Fix bug", "Description");

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

    const updatedItems = getProjectItems(config);
    expect(updatedItems[0].status).toBe("Up Next");
    expect(updatedItems[0].body).toBe("Original body");
  });

  it("stamps [since: N] annotation when item first becomes In Progress", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] Fresh task

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const items = getProjectItems(config);
    updateItemStatus(config, items[0].id, "In Progress", undefined, 50);

    const updated = getProjectItems(config);
    expect(updated[0].body).toContain("[since: 50]");
  });

  it("preserves existing [since: N] annotation when item is already In Progress (prevents clock reset)", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress
- [ ] Ongoing task
  [since: 48]

## Done
`);
    const config = makeConfig();
    const items = getProjectItems(config);
    // Simulate cycle 50 re-picking the same item — should NOT reset [since: 48] to [since: 50]
    updateItemStatus(config, items[0].id, "In Progress", undefined, 50);

    const updated = getProjectItems(config);
    expect(updated[0].body).toContain("[since: 48]");
    expect(updated[0].body).not.toContain("[since: 50]");
  });

  it("stamps a new [since: N] annotation when item has no existing annotation", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress
- [ ] Task without annotation
  Some description

## Done
`);
    const config = makeConfig();
    const items = getProjectItems(config);
    updateItemStatus(config, items[0].id, "In Progress", undefined, 55);

    const updated = getProjectItems(config);
    expect(updated[0].body).toContain("[since: 55]");
    expect(updated[0].body).toContain("Some description");
  });
});

describe("demoteStaleInProgressItems", () => {
  it("returns empty array when roadmap has no In Progress items", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog
- [ ] Backlog task

## Up Next

## In Progress

## Done
`);
    const config = makeConfig();
    const demoted = demoteStaleInProgressItems(config, 10);
    expect(demoted).toEqual([]);
  });

  it("demotes stale In Progress item (no annotation) to Up Next", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress
- [ ] Stuck task

## Done
`);
    const config = makeConfig();
    const demoted = demoteStaleInProgressItems(config, 10);

    expect(demoted).toEqual(["Stuck task"]);
    const items = getProjectItems(config);
    expect(items[0].status).toBe("Up Next");
  });

  it("demotes item stuck beyond threshold and strips [since: N] annotation", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress
- [ ] Long running task
  [since: 5]

## Done
`);
    const config = makeConfig();
    // currentCycle=10, since=5 → 10-5=5 > threshold=3 → stale
    const demoted = demoteStaleInProgressItems(config, 10, 3);

    expect(demoted).toEqual(["Long running task"]);
    const items = getProjectItems(config);
    expect(items[0].status).toBe("Up Next");
    expect(items[0].body).not.toContain("[since:");
  });

  it("does not demote item within staleness threshold", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress
- [ ] Fresh task
  [since: 8]

## Done
`);
    const config = makeConfig();
    // currentCycle=10, since=8 → 10-8=2 ≤ threshold=3 → fresh
    const demoted = demoteStaleInProgressItems(config, 10, 3);

    expect(demoted).toEqual([]);
    const items = getProjectItems(config);
    expect(items[0].status).toBe("In Progress");
  });

  it("demotes only the stale items from a mixed In Progress set", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress
- [ ] Fresh item
  [since: 8]
- [ ] Stale item
  [since: 2]

## Done
`);
    const config = makeConfig();
    // currentCycle=10, threshold=3: fresh 10-8=2≤3, stale 10-2=8>3
    const demoted = demoteStaleInProgressItems(config, 10, 3);

    expect(demoted).toEqual(["Stale item"]);
    const items = getProjectItems(config);
    const freshItem = items.find((i) => i.title === "Fresh item");
    const staleItem = items.find((i) => i.title === "Stale item");
    expect(freshItem?.status).toBe("In Progress");
    expect(staleItem?.status).toBe("Up Next");
  });

  it("preserves non-annotation body text when demoting", () => {
    writeTestRoadmap(`# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress
- [ ] Task with body
  Important context
  [since: 1]

## Done
`);
    const config = makeConfig();
    demoteStaleInProgressItems(config, 10, 3);

    const items = getProjectItems(config);
    expect(items[0].body).toContain("Important context");
    expect(items[0].body).not.toContain("[since:");
  });
});
