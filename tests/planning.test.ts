import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "fs";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockExistsSync = vi.mocked(existsSync);

import { pickNextItem, formatPlanningContext, parseRoadmap, serializeRoadmap, nextItemId, parseInProgressSinceCycle, detectStaleInProgressItems, updateItemStatus, demoteStaleInProgressItems, addLinkedItem, addDraftItem, type ProjectItem } from "../src/planning.js";

function makeItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    id: "item-1",
    title: "Test item",
    status: "Backlog",
    body: "",
    linkedIssueNumber: null,
    reactions: 0,
    ...overrides,
  };
}

describe("pickNextItem", () => {
  it("returns null when no items exist", () => {
    expect(pickNextItem([])).toBeNull();
  });

  it("returns null when all items are Done", () => {
    const items = [
      makeItem({ status: "Done" }),
    ];
    expect(pickNextItem(items)).toBeNull();
  });

  it("prefers In Progress items over Up Next and Backlog", () => {
    const items = [
      makeItem({ id: "backlog-1", title: "Backlog item", status: "Backlog", reactions: 10 }),
      makeItem({ id: "upnext-1", title: "Up Next item", status: "Up Next", reactions: 5 }),
      makeItem({ id: "inprog-1", title: "In Progress item", status: "In Progress", reactions: 1 }),
    ];
    expect(pickNextItem(items)!.id).toBe("inprog-1");
  });

  it("prefers Up Next items over Backlog", () => {
    const items = [
      makeItem({ id: "backlog-1", title: "Backlog item", status: "Backlog", reactions: 10 }),
      makeItem({ id: "upnext-1", title: "Up Next item", status: "Up Next", reactions: 1 }),
    ];
    expect(pickNextItem(items)!.id).toBe("upnext-1");
  });

  it("sorts Up Next items by reactions descending", () => {
    const items = [
      makeItem({ id: "a", status: "Up Next", reactions: 2 }),
      makeItem({ id: "b", status: "Up Next", reactions: 8 }),
      makeItem({ id: "c", status: "Up Next", reactions: 5 }),
    ];
    expect(pickNextItem(items)!.id).toBe("b");
  });

  it("falls back to Backlog when no Up Next items exist", () => {
    const items = [
      makeItem({ id: "a", status: "Backlog", reactions: 3 }),
      makeItem({ id: "b", status: "Backlog", reactions: 7 }),
      makeItem({ id: "c", status: "Done" }),
    ];
    expect(pickNextItem(items)!.id).toBe("b");
  });

  it("sorts Backlog items by reactions descending", () => {
    const items = [
      makeItem({ id: "a", status: "Backlog", reactions: 1 }),
      makeItem({ id: "b", status: "Backlog", reactions: 5 }),
    ];
    expect(pickNextItem(items)!.id).toBe("b");
  });
});

describe("formatPlanningContext", () => {
  it("returns empty string for empty items and null current item", () => {
    expect(formatPlanningContext([], null)).toBe("");
  });

  it("shows current focus item", () => {
    const current = makeItem({ title: "Fix test flakiness" });
    const result = formatPlanningContext([], current);
    expect(result).toContain("## Evolution Roadmap");
    expect(result).toContain("**Current focus**: Fix test flakiness");
  });

  it("shows current focus body preview", () => {
    const current = makeItem({ title: "Task", body: "Detailed description here" });
    const result = formatPlanningContext([], current);
    expect(result).toContain("Detailed description here");
  });

  it("groups items by status", () => {
    const items = [
      makeItem({ title: "Backlog A", status: "Backlog" }),
      makeItem({ title: "Up Next B", status: "Up Next" }),
      makeItem({ title: "Done C", status: "Done" }),
    ];
    const result = formatPlanningContext(items, null);
    expect(result).toContain("### Backlog");
    expect(result).toContain("- Backlog A");
    expect(result).toContain("### Up Next");
    expect(result).toContain("- Up Next B");
    // Done items should be omitted from planning context
    expect(result).not.toContain("### Done");
    expect(result).not.toContain("- Done C");
  });

  it("includes reaction count when non-zero", () => {
    const items = [makeItem({ title: "Popular", status: "Backlog", reactions: 5 })];
    const result = formatPlanningContext(items, null);
    expect(result).toContain("(5 reactions)");
  });

  it("includes linked issue number", () => {
    const items = [makeItem({ title: "From issue", status: "Backlog", linkedIssueNumber: 42 })];
    const result = formatPlanningContext(items, null);
    expect(result).toContain("[#42]");
  });

  it("respects maxChars limit", () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({ id: `item-${i}`, title: `Very long item title number ${i} with lots of detail`, status: "Backlog" }),
    );
    const result = formatPlanningContext(items, null, 100);
    expect(result.length).toBeLessThanOrEqual(105); // "...\n" appended
    expect(result).toContain("...");
  });

  it("truncation does not cut mid-line", () => {
    const items = [
      makeItem({ id: "a", title: "Long Item A Title Here", status: "Backlog" }),
      makeItem({ id: "b", title: "Long Item B Title Here", status: "Backlog" }),
    ];
    // Pick a maxChars that falls mid-way through the second item line
    const maxChars = "## Evolution Roadmap\n\n### Backlog\n- Long Item A Title Here\n- Long".length;
    const result = formatPlanningContext(items, null, maxChars);
    // Line-aware truncation: stops before the partial line B, not mid-word
    expect(result).toMatch(/\n\.\.\.$/);
    expect(result).toContain("- Long Item A Title Here");
    expect(result).not.toContain("- Long Item B");
  });

  it("limits to 5 items per status", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({ id: `item-${i}`, title: `Item ${i}`, status: "Backlog" }),
    );
    const result = formatPlanningContext(items, null);
    const backlogMatches = result.match(/^- Item \d+$/gm);
    expect(backlogMatches!.length).toBe(5);
  });

  it("uses truncated string as-is when no newline found (single long line)", () => {
    // A single item whose title is long enough to exceed maxChars, with no
    // embedded newline, so lastNewline is -1 — exercises the fallback branch.
    const longTitle = "A".repeat(200);
    const items = [makeItem({ title: longTitle, status: "Backlog" })];
    const result = formatPlanningContext(items, null, 50);
    expect(result).toContain("...");
    expect(result.length).toBeLessThanOrEqual(55);
  });

  it("silently drops In Progress items when currentItem is null", () => {
    const items = [makeItem({ title: "Active Work", status: "In Progress" })];
    const result = formatPlanningContext(items, null);
    expect(result).not.toContain("Active Work");
  });

  it("truncated output ends with '\\n...' (positive structural assertion)", () => {
    // Positive assertion: after line-aware truncation the suffix is exactly "\n..."
    // This pins the design decision that lastIndexOf("\n") is used to avoid cutting
    // mid-line, and documents the expected suffix more explicitly than a regex.
    const items = [
      makeItem({ id: "a", title: "Alpha Item", status: "Up Next" }),
      makeItem({ id: "b", title: "Beta Item", status: "Up Next" }),
      makeItem({ id: "c", title: "Gamma Item", status: "Up Next" }),
    ];
    const header = "## Evolution Roadmap\n\n### Up Next\n- Alpha Item\n- Be";
    const maxChars = header.length; // cuts mid-way through "Beta Item" line
    const result = formatPlanningContext(items, null, maxChars);
    expect(result.endsWith("\n...")).toBe(true);
    expect(result).toContain("- Alpha Item");
    expect(result).not.toContain("- Beta Item");
  });
});

describe("parseRoadmap", () => {
  it("parses a well-formed roadmap", () => {
    const content = `# Bloom Evolution Roadmap

## Backlog
- [ ] Fix bug (#3)
  Some description
- [ ] Add feature

## Up Next
- [ ] Important task (#7)

## In Progress

## Done
- [x] Completed item (#1)
`;
    const items = parseRoadmap(content);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({
      title: "Fix bug",
      status: "Backlog",
      body: "Some description",
      linkedIssueNumber: 3,
    });
    expect(items[1]).toMatchObject({
      title: "Add feature",
      status: "Backlog",
      linkedIssueNumber: null,
    });
    expect(items[2]).toMatchObject({
      title: "Important task",
      status: "Up Next",
      linkedIssueNumber: 7,
    });
    expect(items[3]).toMatchObject({
      title: "Completed item",
      status: "Done",
      linkedIssueNumber: 1,
    });
  });

  it("returns empty array for empty content", () => {
    expect(parseRoadmap("")).toEqual([]);
  });

  it("returns empty array for content with no items", () => {
    const content = `# Bloom Evolution Roadmap

## Backlog

## Done
`;
    expect(parseRoadmap(content)).toEqual([]);
  });

  it("handles multi-line body", () => {
    const content = `## Backlog
- [ ] My task
  Line one
  Line two
`;
    const items = parseRoadmap(content);
    expect(items).toHaveLength(1);
    expect(items[0].body).toBe("Line one\nLine two");
  });

  it("ignores items under unknown headings", () => {
    const content = `## Random Section
- [ ] Should be ignored

## Backlog
- [ ] Should be included
`;
    const items = parseRoadmap(content);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Should be included");
  });
});

describe("serializeRoadmap", () => {
  it("serializes items into markdown format", () => {
    const items: ProjectItem[] = [
      makeItem({ title: "Task A", status: "Backlog", linkedIssueNumber: 3, body: "Description" }),
      makeItem({ title: "Task B", status: "Done", linkedIssueNumber: null }),
    ];
    const result = serializeRoadmap(items);
    expect(result).toContain("# Bloom Evolution Roadmap");
    expect(result).toContain("## Backlog");
    expect(result).toContain("- [ ] Task A (#3)");
    expect(result).toContain("  Description");
    expect(result).toContain("## Done");
    expect(result).toContain("- [x] Task B");
  });

  it("produces empty sections for statuses with no items", () => {
    const result = serializeRoadmap([]);
    expect(result).toContain("## Backlog");
    expect(result).toContain("## Up Next");
    expect(result).toContain("## In Progress");
    expect(result).toContain("## Done");
  });

  it("roundtrips through parse and serialize", () => {
    const original: ProjectItem[] = [
      makeItem({ id: "item-0", title: "Alpha", status: "Backlog", linkedIssueNumber: 1, body: "Body A" }),
      makeItem({ id: "item-1", title: "Beta", status: "Up Next", linkedIssueNumber: null, body: "" }),
      makeItem({ id: "item-2", title: "Gamma", status: "Done", linkedIssueNumber: 5, body: "Done body" }),
    ];
    const serialized = serializeRoadmap(original);
    const parsed = parseRoadmap(serialized);

    expect(parsed).toHaveLength(3);
    expect(parsed[0].title).toBe("Alpha");
    expect(parsed[0].status).toBe("Backlog");
    expect(parsed[0].linkedIssueNumber).toBe(1);
    expect(parsed[0].body).toBe("Body A");
    expect(parsed[1].title).toBe("Beta");
    expect(parsed[1].status).toBe("Up Next");
    expect(parsed[2].title).toBe("Gamma");
    expect(parsed[2].status).toBe("Done");
    expect(parsed[2].linkedIssueNumber).toBe(5);
  });

  it("roundtrips multi-line body losslessly through serialize and parse", () => {
    const original: ProjectItem[] = [
      makeItem({ id: "item-0", title: "Multi", status: "Backlog", body: "Line one\nLine two" }),
    ];
    const serialized = serializeRoadmap(original);
    const parsed = parseRoadmap(serialized);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].body).toBe("Line one\nLine two");
  });
});

describe("parseInProgressSinceCycle", () => {
  it("returns null when body is empty", () => {
    expect(parseInProgressSinceCycle("")).toBeNull();
  });

  it("returns null when no annotation is present", () => {
    expect(parseInProgressSinceCycle("some body text without annotation")).toBeNull();
  });

  it("parses [since: N] annotation", () => {
    expect(parseInProgressSinceCycle("[since: 42]")).toBe(42);
  });

  it("parses annotation embedded in multi-line body text", () => {
    expect(parseInProgressSinceCycle("some text\n[since: 10]")).toBe(10);
  });

  it("handles whitespace variations", () => {
    expect(parseInProgressSinceCycle("[since:5]")).toBe(5);
    expect(parseInProgressSinceCycle("[since:  100]")).toBe(100);
  });

  it("returns null for [since: 0] (cycle zero is invalid)", () => {
    expect(parseInProgressSinceCycle("[since: 0]")).toBeNull();
  });

  it("returns null when N exceeds currentCycle (future annotation disables stale detection)", () => {
    expect(parseInProgressSinceCycle("[since: 99999]", 186)).toBeNull();
  });

  it("returns N when annotation is valid and within currentCycle", () => {
    expect(parseInProgressSinceCycle("[since: 100]", 186)).toBe(100);
  });

  it("returns N when currentCycle is not provided (no upper-bound validation)", () => {
    expect(parseInProgressSinceCycle("[since: 99999]")).toBe(99999);
  });
});

describe("detectStaleInProgressItems", () => {
  it("returns empty array when no items", () => {
    expect(detectStaleInProgressItems([], 10)).toEqual([]);
  });

  it("ignores non-In-Progress items", () => {
    const items = [
      makeItem({ status: "Backlog" }),
      makeItem({ status: "Up Next" }),
      makeItem({ status: "Done" }),
    ];
    expect(detectStaleInProgressItems(items, 10)).toEqual([]);
  });

  it("treats In Progress item with no annotation as always stale", () => {
    const item = makeItem({ status: "In Progress", body: "" });
    expect(detectStaleInProgressItems([item], 1)).toHaveLength(1);
  });

  it("detects item stuck beyond threshold as stale", () => {
    // currentCycle=5, since=1 → 5-1=4 > threshold=3 → stale
    const item = makeItem({ status: "In Progress", body: "[since: 1]" });
    expect(detectStaleInProgressItems([item], 5, 3)).toHaveLength(1);
  });

  it("does not flag item within threshold", () => {
    // currentCycle=5, since=3 → 5-3=2 ≤ threshold=3 → fresh
    const item = makeItem({ status: "In Progress", body: "[since: 3]" });
    expect(detectStaleInProgressItems([item], 5, 3)).toHaveLength(0);
  });

  it("does not flag item at exact threshold boundary", () => {
    // currentCycle=5, since=2 → 5-2=3, not > 3 → fresh
    const item = makeItem({ status: "In Progress", body: "[since: 2]" });
    expect(detectStaleInProgressItems([item], 5, 3)).toHaveLength(0);
  });

  it("returns only the stale items from a mixed set", () => {
    const fresh = makeItem({ id: "a", status: "In Progress", body: "[since: 3]" });
    const stale = makeItem({ id: "b", status: "In Progress", body: "[since: 1]" });
    // currentCycle=5, default threshold=3: fresh 5-3=2≤3, stale 5-1=4>3
    const result = detectStaleInProgressItems([fresh, stale], 5);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });
});

describe("updateItemStatus", () => {
  const config = { filePath: "" };

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExistsSync.mockReturnValue(true as any);
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
  });

  it("returns true and writes file when item is found and status changes", () => {
    const items = [makeItem({ id: "item-0", title: "My Task", status: "Backlog" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    const result = updateItemStatus(config, "item-0", "Up Next");

    expect(result).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalled();
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].status).toBe("Up Next");
  });

  it("returns false and does not write when item ID is not found", () => {
    const items = [makeItem({ id: "item-0", title: "Task", status: "Backlog" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    const result = updateItemStatus(config, "item-999", "Done");

    expect(result).toBe(false);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("sets body to completionNote when moving to Done", () => {
    const items = [makeItem({ id: "item-0", title: "Task", status: "In Progress", body: "old body" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    updateItemStatus(config, "item-0", "Done", "Completed successfully");

    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].status).toBe("Done");
    expect(parsed[0].body).toBe("Completed successfully");
  });

  it("preserves old body when moving to Done without a completionNote", () => {
    const items = [makeItem({ id: "item-0", title: "Task", status: "In Progress", body: "original body" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    updateItemStatus(config, "item-0", "Done");

    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].status).toBe("Done");
    expect(parsed[0].body).toBe("original body");
  });

  it("stamps [since: N] annotation when moving to In Progress with sinceCycle", () => {
    const items = [makeItem({ id: "item-0", title: "Task", status: "Up Next", body: "" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    updateItemStatus(config, "item-0", "In Progress", undefined, 42);

    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].body).toContain("[since: 42]");
  });

  it("does not overwrite existing [since: N] annotation when already present", () => {
    // Start in Backlog with a pre-existing annotation so status change triggers a write
    const items = [makeItem({ id: "item-0", title: "Task", status: "Backlog", body: "[since: 10]" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    // Moving to In Progress with sinceCycle=99 — but [since: 10] already exists
    updateItemStatus(config, "item-0", "In Progress", undefined, 99);

    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    // Original annotation should be preserved, not replaced with 99
    expect(parsed[0].body).toContain("[since: 10]");
    expect(parsed[0].body).not.toContain("[since: 99]");
  });

  it("preserves body unchanged when two [since: N] annotations are present (no overwrite)", () => {
    // Body has two [since:] tags — the first is found by .match(), preventing a new stamp.
    // Both annotations survive because the body is left untouched.
    const items = [makeItem({ id: "item-0", title: "Task", status: "Up Next", body: "work done\n[since: 10]\n[since: 20]" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    updateItemStatus(config, "item-0", "In Progress", undefined, 99);

    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    // existingAnnotation finds the first [since: 10], so body is NOT modified
    expect(parsed[0].body).toContain("[since: 10]");
    expect(parsed[0].body).toContain("[since: 20]");
    expect(parsed[0].body).not.toContain("[since: 99]");
  });

  it("does not write file when new status matches current status (no-op)", () => {
    // Item is already "Up Next" — calling updateItemStatus with same status should be a no-op
    const items = [makeItem({ id: "item-0", title: "Task", status: "Up Next" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    const result = updateItemStatus(config, "item-0", "Up Next");

    expect(result).toBe(true); // item was found
    expect(mockWriteFileSync).not.toHaveBeenCalled(); // no change → no write
  });

  it("does not add [since: N] annotation when moving to In Progress without sinceCycle", () => {
    const items = [makeItem({ id: "item-0", title: "Task", status: "Up Next", body: "original" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    updateItemStatus(config, "item-0", "In Progress"); // no sinceCycle argument

    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].status).toBe("In Progress");
    expect(parsed[0].body).toBe("original");
    expect(parsed[0].body).not.toMatch(/\[since:/);
  });
});

describe("demoteStaleInProgressItems", () => {
  const config = { filePath: "" };

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExistsSync.mockReturnValue(true as any);
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
  });

  it("returns empty array when no items are stale", () => {
    // currentCycle=5, since=3 → 5-3=2 ≤ threshold=3 → fresh
    const items = [makeItem({ id: "item-0", title: "Active Task", status: "In Progress", body: "[since: 3]" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    const result = demoteStaleInProgressItems(config, 5, 3);

    expect(result).toEqual([]);
  });

  it("returns title of demoted item when stale", () => {
    // currentCycle=10, since=1 → 10-1=9 > threshold=3 → stale
    const items = [makeItem({ id: "item-0", title: "Stuck Task", status: "In Progress", body: "[since: 1]" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    const result = demoteStaleInProgressItems(config, 10, 3);

    expect(result).toEqual(["Stuck Task"]);
  });

  it("moves stale item to Up Next in written roadmap", () => {
    const items = [makeItem({ id: "item-0", title: "Stale Task", status: "In Progress", body: "[since: 1]" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    demoteStaleInProgressItems(config, 10, 3);

    expect(mockWriteFileSync).toHaveBeenCalled();
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].status).toBe("Up Next");
  });

  it("strips [since: N] annotation from demoted item body", () => {
    const items = [makeItem({ id: "item-0", title: "Task", status: "In Progress", body: "some work\n[since: 1]" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    demoteStaleInProgressItems(config, 10, 3);

    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].body).not.toMatch(/\[since:/);
  });

  it("treats item with no [since: N] annotation as always stale", () => {
    const items = [makeItem({ id: "item-0", title: "Old Task", status: "In Progress", body: "" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    const result = demoteStaleInProgressItems(config, 1, 3);

    expect(result).toEqual(["Old Task"]);
  });

  it("only demotes stale items from a mixed set", () => {
    const items = [
      makeItem({ id: "item-0", title: "Fresh Task", status: "In Progress", body: "[since: 8]" }),
      makeItem({ id: "item-1", title: "Stale Task", status: "In Progress", body: "[since: 1]" }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    // currentCycle=10, threshold=3: fresh 10-8=2≤3, stale 10-1=9>3
    const result = demoteStaleInProgressItems(config, 10, 3);

    expect(result).toEqual(["Stale Task"]);
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    const freshItem = parsed.find((i) => i.title === "Fresh Task");
    const staleItem = parsed.find((i) => i.title === "Stale Task");
    expect(freshItem?.status).toBe("In Progress");
    expect(staleItem?.status).toBe("Up Next");
  });
});

describe("addLinkedItem", () => {
  const config = { filePath: "" };

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExistsSync.mockReturnValue(true as any);
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
  });

  it("adds a new linked item and returns its id", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap([]) as any);
    const id = addLinkedItem(config, 5, "My Issue", "Issue body");
    expect(id).toBe("item-0");
    expect(mockWriteFileSync).toHaveBeenCalled();
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].linkedIssueNumber).toBe(5);
    expect(parsed[0].title).toBe("My Issue");
    expect(parsed[0].status).toBe("Backlog");
  });

  it("returns existing item id when issue number already exists (no write)", () => {
    const existing = [makeItem({ id: "item-0", title: "Existing", status: "Backlog", linkedIssueNumber: 5 })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(existing) as any);
    const id = addLinkedItem(config, 5, "My Issue", "Issue body");
    expect(id).toBe("item-0");
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("respects the status parameter when specified", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap([]) as any);
    addLinkedItem(config, 7, "Urgent Task", "body", "Up Next");
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].status).toBe("Up Next");
  });

  it("truncates body to 200 characters", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap([]) as any);
    const longBody = "x".repeat(300);
    addLinkedItem(config, 9, "Title", longBody);
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].body.length).toBeLessThanOrEqual(200);
  });
});

describe("addDraftItem", () => {
  const config = { filePath: "" };

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExistsSync.mockReturnValue(true as any);
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
  });

  it("adds a new draft item and returns its id", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap([]) as any);
    const id = addDraftItem(config, "Draft Task", "Some body");
    expect(id).toBe("item-0");
    expect(mockWriteFileSync).toHaveBeenCalled();
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].title).toBe("Draft Task");
    expect(parsed[0].linkedIssueNumber).toBeNull();
    expect(parsed[0].status).toBe("Backlog");
  });

  it("returns existing item id when title already exists (no write)", () => {
    const existing = [makeItem({ id: "item-0", title: "Draft Task", status: "Backlog" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(existing) as any);
    const id = addDraftItem(config, "Draft Task", "body");
    expect(id).toBe("item-0");
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("respects the status parameter when specified", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap([]) as any);
    addDraftItem(config, "My Task", "body", "Up Next");
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].status).toBe("Up Next");
  });

  it("truncates body to 200 characters", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap([]) as any);
    const longBody = "y".repeat(300);
    addDraftItem(config, "Long Body Task", longBody);
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].body.length).toBeLessThanOrEqual(200);
  });
});

describe("nextItemId", () => {
  it("returns item-0 for empty array", () => {
    expect(nextItemId([])).toBe("item-0");
  });

  it("returns next sequential ID for consecutive items", () => {
    const items = [
      makeItem({ id: "item-0" }),
      makeItem({ id: "item-1" }),
      makeItem({ id: "item-2" }),
    ];
    expect(nextItemId(items)).toBe("item-3");
  });

  it("handles gaps in ID sequence (e.g., after item removal)", () => {
    const items = [
      makeItem({ id: "item-0" }),
      makeItem({ id: "item-3" }),
      makeItem({ id: "item-5" }),
    ];
    expect(nextItemId(items)).toBe("item-6");
  });

  it("handles single item", () => {
    const items = [makeItem({ id: "item-7" })];
    expect(nextItemId(items)).toBe("item-8");
  });

  it("skips items with malformed IDs and still returns next ID after valid ones", () => {
    const items = [
      makeItem({ id: "item-abc" }),
      makeItem({ id: "invalid" }),
      makeItem({ id: "item-5" }),
    ];
    expect(nextItemId(items)).toBe("item-6");
  });
});
