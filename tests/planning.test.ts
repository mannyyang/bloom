import { describe, it, expect } from "vitest";
import { pickNextItem, formatPlanningContext, parseRoadmap, serializeRoadmap, nextItemId, parseInProgressSinceCycle, detectStaleInProgressItems, type ProjectItem } from "../src/planning.js";

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
    expect(result).toContain("### Done");
    expect(result).toContain("- Done C");
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

  it("limits to 5 items per status", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({ id: `item-${i}`, title: `Item ${i}`, status: "Backlog" }),
    );
    const result = formatPlanningContext(items, null);
    const backlogMatches = result.match(/^- Item \d+$/gm);
    expect(backlogMatches!.length).toBe(5);
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
});
