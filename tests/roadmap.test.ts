import { describe, it, expect, vi } from "vitest";
import { generateRoadmapOutput } from "../src/roadmap.js";
import * as planning from "../src/planning.js";
import { parseRoadmap } from "../src/planning.js";

const SAMPLE_ROADMAP = `# Bloom Evolution Roadmap

## Backlog
- [ ] Improve prompt efficiency
  Target: reduce median cycle cost by ~20%.
- [ ] Track conversion rate (#99)

## Up Next
- [ ] Add error classification (#15)

## In Progress
- [ ] Write more tests (#8)

## Done
- [x] Track token usage (#4)
  Completed in cycle 75.
`;

const EMPTY_ROADMAP = `# Bloom Evolution Roadmap

## Backlog

## Up Next

## In Progress

## Done
`;

describe("generateRoadmapOutput", () => {
  it("returns an array of strings", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    expect(Array.isArray(output)).toBe(true);
    expect(output.length).toBeGreaterThan(0);
  });

  it("includes the header banner", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("Bloom Evolution Roadmap");
    expect(joined).toContain("========================================");
  });

  it("shows In Progress items first", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    const inProgressIdx = joined.indexOf("IN PROGRESS");
    const backlogIdx = joined.indexOf("BACKLOG");
    expect(inProgressIdx).toBeGreaterThanOrEqual(0);
    expect(inProgressIdx).toBeLessThan(backlogIdx);
  });

  it("shows Done items last", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    const doneIdx = joined.indexOf("DONE");
    const backlogIdx = joined.indexOf("BACKLOG");
    expect(doneIdx).toBeGreaterThan(backlogIdx);
  });

  it("includes item titles", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("Improve prompt efficiency");
    expect(joined).toContain("Write more tests");
    expect(joined).toContain("Track token usage");
  });

  it("includes linked issue numbers", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("(#99)");
    expect(joined).toContain("(#4)");
  });

  it("includes body descriptions", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("reduce median cycle cost");
  });

  it("marks Done items with a check symbol", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    // Done items should use ✓
    expect(joined).toContain("✓ Track token usage");
  });

  it("marks non-Done items with an open circle", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("○ Improve prompt efficiency");
  });

  it("shows a placeholder message when roadmap is empty", () => {
    const output = generateRoadmapOutput(EMPTY_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("No items on the roadmap yet.");
  });

  it("skips status sections that have no items", () => {
    const output = generateRoadmapOutput(EMPTY_ROADMAP);
    const joined = output.join("\n");
    // Empty sections should not appear as headers
    expect(joined).not.toContain("BACKLOG");
    expect(joined).not.toContain("IN PROGRESS");
  });

  it("handles an empty string input gracefully", () => {
    const output = generateRoadmapOutput("");
    expect(Array.isArray(output)).toBe(true);
    const joined = output.join("\n");
    expect(joined).toContain("No items on the roadmap yet.");
  });

  it("truncates body descriptions longer than 120 characters", () => {
    const longBody = "x".repeat(130);
    const roadmapWithLongBody = `# Bloom Evolution Roadmap\n\n## Backlog\n- [ ] Long body item\n  ${longBody}\n`;
    const output = generateRoadmapOutput(roadmapWithLongBody);
    const joined = output.join("\n");
    // Should contain the ellipsis truncation marker
    expect(joined).toContain("…");
    // Should not contain the full 130-char body
    expect(joined).not.toContain("x".repeat(130));
    // Should contain the first 120 characters
    expect(joined).toContain("x".repeat(120));
  });

  it("renders multi-line body as separate indented lines", () => {
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Multi-line item",
        status: "Backlog",
        body: "line1\nline2",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("      line1");
    expect(joined).toContain("      line2");
    spy.mockRestore();
  });

  it("shows [N ★] suffix for items with reactions > 0", () => {
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Popular feature",
        status: "Backlog",
        body: "",
        linkedIssueNumber: null,
        reactions: 7,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("[7 ★]");
    spy.mockRestore();
  });

  it("omits reaction suffix for items with reactions === 0", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    // The SAMPLE_ROADMAP items all have 0 reactions (parser default)
    expect(joined).not.toContain("★");
  });
});

describe("parseRoadmap", () => {
  it("ignores items that appear before the first ## heading", () => {
    const content = `# Bloom Evolution Roadmap

- [ ] Orphan item before any heading
- [ ] Another orphan

## Backlog
- [ ] Real backlog item
`;
    const items = parseRoadmap(content);
    // Only the item under ## Backlog should be parsed; orphans are silently dropped
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Real backlog item");
  });
});
