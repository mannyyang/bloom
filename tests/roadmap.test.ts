import { describe, it, expect, vi } from "vitest";
import { generateRoadmapOutput, ROADMAP_BODY_PREVIEW_MAX_CHARS } from "../src/roadmap.js";
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

  it("empty roadmap output has exactly 7 entries (structural pin)", () => {
    // Empty path always produces: ["", sep, title, sep, "", "  No items on the roadmap yet.", ""]
    // Mirrors the stats.test.ts position-pin pattern (8 lines no memory, 10 with memory).
    // Any addition of a blank line or extra section in the empty branch would break this.
    const output = generateRoadmapOutput(EMPTY_ROADMAP);
    expect(output).toHaveLength(7);
    expect(output[1]).toBe("========================================");
    expect(output[3]).toBe("========================================");
    expect(output[5]).toBe("  No items on the roadmap yet.");
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

  it("ROADMAP_BODY_PREVIEW_MAX_CHARS is 120 (value-pinning)", () => {
    expect(ROADMAP_BODY_PREVIEW_MAX_CHARS).toBe(120);
  });

  it("truncates body descriptions longer than ROADMAP_BODY_PREVIEW_MAX_CHARS characters", () => {
    const longBody = "x".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS + 10);
    const roadmapWithLongBody = `# Bloom Evolution Roadmap\n\n## Backlog\n- [ ] Long body item\n  ${longBody}\n`;
    const output = generateRoadmapOutput(roadmapWithLongBody);
    const joined = output.join("\n");
    // Should contain the ellipsis truncation marker
    expect(joined).toContain("…");
    // Should not contain the full over-length body
    expect(joined).not.toContain("x".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS + 10));
    // Should contain the first ROADMAP_BODY_PREVIEW_MAX_CHARS characters
    expect(joined).toContain("x".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS));
  });

  it("does not truncate a body of exactly ROADMAP_BODY_PREVIEW_MAX_CHARS characters", () => {
    const exactBody = "y".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS);
    const roadmap = `# Bloom Evolution Roadmap\n\n## Backlog\n- [ ] Exact boundary item\n  ${exactBody}\n`;
    const output = generateRoadmapOutput(roadmap);
    const joined = output.join("\n");
    // No ellipsis — body is exactly at the limit, not over it
    expect(joined).not.toContain("…");
    // Full body should appear
    expect(joined).toContain("y".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS));
  });

  it("truncates a body of ROADMAP_BODY_PREVIEW_MAX_CHARS + 1 characters with ellipsis", () => {
    const overBody = "z".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS + 1);
    const roadmap = `# Bloom Evolution Roadmap\n\n## Backlog\n- [ ] Over boundary item\n  ${overBody}\n`;
    const output = generateRoadmapOutput(roadmap);
    const joined = output.join("\n");
    // Ellipsis must appear
    expect(joined).toContain("…");
    // Only first ROADMAP_BODY_PREVIEW_MAX_CHARS chars should be in output
    expect(joined).toContain("z".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS));
    expect(joined).not.toContain("z".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS + 1));
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

  it("preserves parse-order for multiple items within the same status section", () => {
    // SAMPLE_ROADMAP has two Backlog items in this order:
    //   1. "Improve prompt efficiency"
    //   2. "Track conversion rate (#99)"
    // The output must preserve that order.
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    const idxFirst = joined.indexOf("Improve prompt efficiency");
    const idxSecond = joined.indexOf("Track conversion rate");
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxSecond).toBeGreaterThanOrEqual(0);
    expect(idxFirst).toBeLessThan(idxSecond);
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

  it("parses item with both a linked issue number and an indented body description", () => {
    const content = `# Bloom Evolution Roadmap

## Backlog
- [ ] Task with desc (#12)
  indented detail
`;
    const items = parseRoadmap(content);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Task with desc");
    expect(items[0].linkedIssueNumber).toBe(12);
    expect(items[0].body).toBe("indented detail");
  });
});
