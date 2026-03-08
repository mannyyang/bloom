import { describe, it, expect } from "vitest";
import { pickNextItem, formatPlanningContext, type ProjectItem, type ProjectConfig } from "../src/planning.js";

function makeItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    id: "item-1",
    title: "Test item",
    status: "Backlog",
    body: "",
    fieldValueId: null,
    linkedIssueNumber: null,
    reactions: 0,
    ...overrides,
  };
}

function makeConfig(): ProjectConfig {
  return {
    projectId: "proj-1",
    statusFieldId: "field-1",
    statusOptions: new Map([
      ["Backlog", "opt-1"],
      ["Up Next", "opt-2"],
      ["In Progress", "opt-3"],
      ["Done", "opt-4"],
    ]),
  };
}

describe("pickNextItem", () => {
  it("returns null when no items exist", () => {
    expect(pickNextItem([])).toBeNull();
  });

  it("returns null when all items are Done or In Progress", () => {
    const items = [
      makeItem({ status: "Done" }),
      makeItem({ status: "In Progress" }),
    ];
    expect(pickNextItem(items)).toBeNull();
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
