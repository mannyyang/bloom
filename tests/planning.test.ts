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

import { pickNextItem, formatPlanningContext, parseRoadmap, serializeRoadmap, nextItemId, parseInProgressSinceCycle, detectStaleInProgressItems, updateItemStatus, demoteStaleInProgressItems, addLinkedItem, addDraftItem, getProjectItems, PLANNING_BODY_PREVIEW_CHARS, ITEM_BODY_LIMIT, PLANNING_CONTEXT_MAX_CHARS, PLANNING_CONTEXT_MAX_ITEMS, STALE_IN_PROGRESS_THRESHOLD_CYCLES, ROADMAP_HEADER, type ProjectItem } from "../src/planning.js";

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

describe("planning.ts constants", () => {
  it("PLANNING_CONTEXT_MAX_CHARS equals 1200", () => {
    expect(PLANNING_CONTEXT_MAX_CHARS).toBe(1200);
  });

  it("PLANNING_CONTEXT_MAX_ITEMS equals 5", () => {
    expect(PLANNING_CONTEXT_MAX_ITEMS).toBe(5);
  });

  it("PLANNING_BODY_PREVIEW_CHARS is pinned to 200", () => {
    expect(PLANNING_BODY_PREVIEW_CHARS).toBe(200);
  });

  it("ITEM_BODY_LIMIT is pinned to 500", () => {
    expect(ITEM_BODY_LIMIT).toBe(500);
  });

  it("STALE_IN_PROGRESS_THRESHOLD_CYCLES is pinned to 3", () => {
    expect(STALE_IN_PROGRESS_THRESHOLD_CYCLES).toBe(3);
  });

  it('ROADMAP_HEADER is pinned to "# Bloom Evolution Roadmap"', () => {
    expect(ROADMAP_HEADER).toBe("# Bloom Evolution Roadmap");
  });
});

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

  it("breaks ties by numeric ID — lowest-numbered item wins (item-2 beats item-10)", () => {
    // item-10 sorts before item-2 with localeCompare ("1" < "2") but should lose
    // numerically (10 > 2). The numeric tiebreaker must pick item-2.
    const items = [
      makeItem({ id: "item-10", status: "Up Next", reactions: 5 }),
      makeItem({ id: "item-2",  status: "Up Next", reactions: 5 }),
      makeItem({ id: "item-7",  status: "Up Next", reactions: 5 }),
    ];
    expect(pickNextItem(items)!.id).toBe("item-2");
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

  it("PLANNING_BODY_PREVIEW_CHARS is a positive integer", () => {
    expect(Number.isInteger(PLANNING_BODY_PREVIEW_CHARS)).toBe(true);
    expect(PLANNING_BODY_PREVIEW_CHARS).toBeGreaterThan(0);
  });

  it("ITEM_BODY_LIMIT is a positive integer", () => {
    expect(Number.isInteger(ITEM_BODY_LIMIT)).toBe(true);
    expect(ITEM_BODY_LIMIT).toBeGreaterThan(0);
  });

  it("truncates current focus body to PLANNING_BODY_PREVIEW_CHARS characters", () => {
    const longBody = "B".repeat(PLANNING_BODY_PREVIEW_CHARS + 50);
    const current = makeItem({ title: "Task", body: longBody });
    const result = formatPlanningContext([], current);
    expect(result).toContain("B".repeat(PLANNING_BODY_PREVIEW_CHARS));
    expect(result).not.toContain("B".repeat(PLANNING_BODY_PREVIEW_CHARS + 1));
  });

  it("does not truncate current focus body at exactly PLANNING_BODY_PREVIEW_CHARS characters", () => {
    const exactBody = "C".repeat(PLANNING_BODY_PREVIEW_CHARS);
    const current = makeItem({ title: "Task", body: exactBody });
    const result = formatPlanningContext([], current);
    expect(result).toContain(exactBody);
  });

  it("strips [since: N] annotation from current focus body preview", () => {
    const current = makeItem({ title: "Task", body: "Real content\n[since: 42]" });
    const result = formatPlanningContext([], current);
    expect(result).not.toContain("[since: 42]");
  });

  it("preserves real body content when stripping [since: N] annotation", () => {
    const current = makeItem({ title: "Task", body: "Real content\n[since: 42]" });
    const result = formatPlanningContext([], current);
    expect(result).toContain("Real content");
  });

  it("does not push blank line when body is only a [since: N] annotation", () => {
    const current = makeItem({ title: "Task", body: "[since: 337]" });
    const result = formatPlanningContext([], current);
    // After stripping the annotation the body is empty; the result should end
    // with the title line and not have a trailing newline from an empty body push.
    expect(result).not.toContain("[since: 337]");
    expect(result.endsWith("**Current focus**: Task")).toBe(true);
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

  it("limits to PLANNING_CONTEXT_MAX_ITEMS items per status", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({ id: `item-${i}`, title: `Item ${i}`, status: "Backlog" }),
    );
    const result = formatPlanningContext(items, null);
    const backlogMatches = result.match(/^- Item \d+$/gm);
    expect(backlogMatches!.length).toBe(PLANNING_CONTEXT_MAX_ITEMS);
  });

  it("respects custom maxItemsPerSection parameter", () => {
    // 4 Backlog items, cap of 2 → exactly 2 bullet lines should appear
    const items = Array.from({ length: 4 }, (_, i) =>
      makeItem({ id: `item-${i}`, title: `Backlog ${i}`, status: "Backlog" }),
    );
    const result = formatPlanningContext(items, null, 2000, 2);
    const backlogMatches = result.match(/^- Backlog \d+$/gm);
    expect(backlogMatches!.length).toBe(2);
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

  it("renders In Progress items when currentItem is null (assess mode)", () => {
    const items = [makeItem({ title: "Active Work", status: "In Progress" })];
    const result = formatPlanningContext(items, null);
    expect(result).toContain("In Progress");
    expect(result).toContain("Active Work");
  });

  it("renders all In Progress items not equal to currentItem when currentItem is set", () => {
    // Regression guard: when currentItem points to one In Progress item, any
    // additional In Progress items (not equal to currentItem) must still appear
    // in the rendered context under an "In Progress" section header.
    const item1 = makeItem({ id: "ip-1", title: "Primary Task", status: "In Progress" });
    const item2 = makeItem({ id: "ip-2", title: "Secondary Task", status: "In Progress" });
    const result = formatPlanningContext([item1, item2], item1);
    // currentItem rendered as **Current focus**
    expect(result).toContain("Primary Task");
    // extra In Progress item rendered in its own section
    expect(result).toContain("In Progress");
    expect(result).toContain("Secondary Task");
  });

  it("excludes null-status items from planning context (behaviour guard)", () => {
    // null-status items cannot be produced by parseRoadmap but can be constructed
    // directly. formatPlanningContext must silently exclude them rather than
    // crashing or showing them under an unknown section header.
    const items = [
      makeItem({ id: "null-1", title: "Null Status Item", status: null as unknown as "Backlog", reactions: 0 }),
      makeItem({ id: "real-1", title: "Real Backlog Item", status: "Backlog" }),
    ];
    const result = formatPlanningContext(items, null);
    expect(result).not.toContain("Null Status Item");
    expect(result).toContain("Real Backlog Item");
  });

  it("excludes Done items from planning context to keep prompt concise", () => {
    // Regression guard: planning.ts line 411 has `if (status === "Done") continue;`
    // Done items are intentionally omitted so resolved work never inflates the LLM prompt.
    const items = [
      makeItem({ id: "done-1", title: "Resolved Feature", status: "Done", reactions: 10 }),
      makeItem({ id: "done-2", title: "Old Bug Fix", status: "Done", linkedIssueNumber: 5 }),
    ];
    const result = formatPlanningContext(items, null);
    expect(result).not.toContain("### Done");
    expect(result).not.toContain("Resolved Feature");
    expect(result).not.toContain("Old Bug Fix");
  });

  it("returns result verbatim when output fits within maxChars", () => {
    // Pins the early-return branch: result.length <= maxChars → no truncation.
    const items = [makeItem({ title: "Short", status: "Backlog" })];
    const expected = formatPlanningContext(items, null);
    // Provide a generous limit well above the actual output length.
    const result = formatPlanningContext(items, null, expected.length + 500);
    expect(result).toBe(expected);
    expect(result).not.toContain("...");
  });

  it("truncates at last newline when output exceeds maxChars and a newline precedes the cut", () => {
    // Pins the newline-boundary branch: lastNewline > 0 → slice at newline, append "\n...".
    const items = [
      makeItem({ id: "x", title: "First Item", status: "Backlog" }),
      makeItem({ id: "y", title: "Second Item", status: "Backlog" }),
    ];
    const full = "## Evolution Roadmap\n\n### Backlog\n- First Item\n- Second Item";
    // Set maxChars to cut mid-way through "- Second Item" so lastNewline > 0.
    const maxChars = full.indexOf("- Second Item") + 3; // "- S" included
    const result = formatPlanningContext(items, null, maxChars);
    expect(result).toBe("## Evolution Roadmap\n\n### Backlog\n- First Item\n...");
  });

  it("hard-cuts at maxChars when no newline precedes the cut point", () => {
    // Pins the no-newline fallback: lastNewline <= 0 → use raw truncated string + "\n...".
    // A maxChars of 5 slices into the header "## Ev" with no newline in that prefix.
    const items = [makeItem({ title: "Anything", status: "Backlog" })];
    const result = formatPlanningContext(items, null, 5);
    expect(result).toBe("## Ev\n...");
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

  it("assigns section heading status to [x] checked items under non-Done sections", () => {
    // A [x] checkbox under ## Backlog should inherit the Backlog status,
    // not be promoted to Done — the section heading wins over checkbox state.
    const content = `## Backlog
- [x] Checked but still Backlog
`;
    const items = parseRoadmap(content);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Checked but still Backlog");
    expect(items[0].status).toBe("Backlog");
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

  it("flags item stuck exactly STALE_IN_PROGRESS_THRESHOLD_CYCLES+1 cycles as stale (boundary above)", () => {
    // diff = STALE_IN_PROGRESS_THRESHOLD_CYCLES + 1 → strictly greater than threshold → stale
    const cycleCount = 10;
    const since = cycleCount - (STALE_IN_PROGRESS_THRESHOLD_CYCLES + 1);
    const item = makeItem({ status: "In Progress", body: `[since: ${since}]` });
    expect(detectStaleInProgressItems([item], cycleCount)).toHaveLength(1);
  });

  it("does not flag item stuck exactly STALE_IN_PROGRESS_THRESHOLD_CYCLES cycles (boundary at threshold)", () => {
    // diff = STALE_IN_PROGRESS_THRESHOLD_CYCLES → not strictly greater → fresh
    const cycleCount = 10;
    const since = cycleCount - STALE_IN_PROGRESS_THRESHOLD_CYCLES;
    const item = makeItem({ status: "In Progress", body: `[since: ${since}]` });
    expect(detectStaleInProgressItems([item], cycleCount)).toHaveLength(0);
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

  it("does not demote item at exact threshold boundary (diff === threshold)", () => {
    // currentCycle=5, since=2 → diff=3, NOT > 3 → fresh (boundary: equal is not stale)
    const items = [makeItem({ id: "item-0", title: "Boundary Task", status: "In Progress", body: "[since: 2]" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    const result = demoteStaleInProgressItems(config, 5, 3);

    expect(result).toEqual([]);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("demotes item one cycle past threshold (diff === threshold + 1)", () => {
    // currentCycle=5, since=1 → diff=4, > 3 → stale (one cycle over threshold)
    const items = [makeItem({ id: "item-0", title: "Just Stale Task", status: "In Progress", body: "[since: 1]" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap(items) as any);

    const result = demoteStaleInProgressItems(config, 5, 3);

    expect(result).toEqual(["Just Stale Task"]);
    expect(mockWriteFileSync).toHaveBeenCalled();
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

  it("truncates body to ITEM_BODY_LIMIT characters and appends truncation indicator", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap([]) as any);
    const longBody = "x".repeat(600);
    addLinkedItem(config, 9, "Title", longBody);
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].body.startsWith("x".repeat(ITEM_BODY_LIMIT))).toBe(true);
    expect(parsed[0].body.endsWith(" \u2026[truncated]")).toBe(true);
  });

  it("emits console.warn when body is truncated", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap([]) as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const longBody = "x".repeat(600);
    addLinkedItem(config, 12, "Title", longBody);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("truncated"));
    warnSpy.mockRestore();
  });

  it("does not emit console.warn when body is within limit", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap([]) as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shortBody = "x".repeat(100);
    addLinkedItem(config, 13, "Title", shortBody);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
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

  it("truncates body to ITEM_BODY_LIMIT characters and appends truncation indicator", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap([]) as any);
    const longBody = "y".repeat(600);
    addDraftItem(config, "Long Body Task", longBody);
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed[0].body.startsWith("y".repeat(ITEM_BODY_LIMIT))).toBe(true);
    expect(parsed[0].body.endsWith(" \u2026[truncated]")).toBe(true);
  });

  it("emits console.warn when body is truncated", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap([]) as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const longBody = "y".repeat(600);
    addDraftItem(config, "Long Draft Task", longBody);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("truncated"));
    warnSpy.mockRestore();
  });

  it("does not emit console.warn when body is within limit", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadFileSync.mockReturnValue(serializeRoadmap([]) as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shortBody = "y".repeat(100);
    addDraftItem(config, "Short Draft Task", shortBody);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("works when roadmap file does not exist (empty-content fallback path)", () => {
    // mockExistsSync returns false → withRoadmapItems uses "" as content
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExistsSync.mockReturnValue(false as any);
    const id = addDraftItem(config, "Brand New Task", "body text");
    expect(id).toBe("item-0");
    expect(mockWriteFileSync).toHaveBeenCalled();
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseRoadmap(written);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe("Brand New Task");
  });
});

describe("getProjectItems", () => {
  const config = { filePath: "" };

  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
  });

  it("returns empty array when roadmap file does not exist", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExistsSync.mockReturnValue(false as any);
    const items = getProjectItems(config);
    expect(items).toEqual([]);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe("parse→serialize→parse roundtrip", () => {
  it("preserves structural identity for a multi-section roadmap string", () => {
    const input = `# Bloom Evolution Roadmap

## Backlog
- [ ] Fix bug (#3)
  Some description

## Up Next
- [ ] Important feature (#7)

## In Progress
- [ ] Active task
  [since: 42]

## Done
- [x] Completed thing (#1)
  Completion note
`;
    const items = parseRoadmap(input);
    const serialized = serializeRoadmap(items);
    const reparsed = parseRoadmap(serialized);

    expect(reparsed).toHaveLength(items.length);
    for (let i = 0; i < items.length; i++) {
      expect(reparsed[i].title).toBe(items[i].title);
      expect(reparsed[i].status).toBe(items[i].status);
      expect(reparsed[i].linkedIssueNumber).toBe(items[i].linkedIssueNumber);
      expect(reparsed[i].body).toBe(items[i].body);
    }
  });

  it("preserves [since: N] annotation through roundtrip", () => {
    const input = `## In Progress
- [ ] Active work
  Some context
  [since: 99]
`;
    const items = parseRoadmap(input);
    expect(items).toHaveLength(1);
    const reparsed = parseRoadmap(serializeRoadmap(items));
    expect(reparsed[0].body).toBe(items[0].body);
    expect(parseInProgressSinceCycle(reparsed[0].body)).toBe(99);
  });

  it("preserves backticks and special chars in item title through roundtrip", () => {
    const input = `## Backlog
- [ ] Add \`code\` support & fix <edge> cases
`;
    const items = parseRoadmap(input);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Add `code` support & fix <edge> cases");
    const reparsed = parseRoadmap(serializeRoadmap(items));
    expect(reparsed[0].title).toBe(items[0].title);
  });

  it("empty roadmap string roundtrips to empty item list", () => {
    const items = parseRoadmap("");
    const reparsed = parseRoadmap(serializeRoadmap(items));
    expect(reparsed).toHaveLength(0);
  });

  it("item counts per section are preserved through roundtrip", () => {
    const input = `## Backlog
- [ ] Backlog A
- [ ] Backlog B

## Up Next
- [ ] Up Next A

## In Progress
- [ ] In Progress A
  [since: 10]

## Done
- [x] Done A
- [x] Done B
- [x] Done C
`;
    const items = parseRoadmap(input);
    const reparsed = parseRoadmap(serializeRoadmap(items));
    const countByStatus = (status: string) => reparsed.filter((i) => i.status === status).length;
    expect(countByStatus("Backlog")).toBe(2);
    expect(countByStatus("Up Next")).toBe(1);
    expect(countByStatus("In Progress")).toBe(1);
    expect(countByStatus("Done")).toBe(3);
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
