import { describe, it, expect, vi } from "vitest";
import { generateRoadmapOutput, generateRoadmapJson, parseRoadmapFilterFlag, ROADMAP_BODY_PREVIEW_MAX_CHARS, type RoadmapJsonSummary } from "../src/roadmap.js";
import * as planning from "../src/planning.js";
import { parseRoadmap, serializeRoadmap } from "../src/planning.js";

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

  it("shows Up Next between In Progress and Backlog", () => {
    // Ordering contract: STATUS_ORDER = [In Progress, Up Next, Backlog, Done].
    // If Up Next and Backlog were swapped in STATUS_ORDER the existing "shows
    // In Progress items first" test would still pass. This test pins the full
    // three-way ordering so any reshuffle of those two statuses is caught.
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    const inProgressIdx = joined.indexOf("IN PROGRESS");
    const upNextIdx = joined.indexOf("UP NEXT");
    const backlogIdx = joined.indexOf("BACKLOG");
    expect(inProgressIdx).toBeGreaterThanOrEqual(0);
    expect(upNextIdx).toBeGreaterThanOrEqual(0);
    expect(backlogIdx).toBeGreaterThanOrEqual(0);
    expect(inProgressIdx).toBeLessThan(upNextIdx);
    expect(upNextIdx).toBeLessThan(backlogIdx);
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

  it("does not display [since: N] annotations in CLI output", () => {
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "In-progress item",
        status: "In Progress",
        body: "Some description\n[since: 330]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("Some description");
    expect(joined).not.toContain("[since:");
    spy.mockRestore();
  });

  it("shows '(since cycle N)' on the title line for In Progress items with a [since: N] annotation", () => {
    // Improvement: staleness is now visible in CLI output so humans can spot stuck work
    // without reading raw ROADMAP.md. The [since: N] annotation in body is translated
    // to a human-readable "(since cycle N)" suffix on the item's title line.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Stuck item",
        status: "In Progress",
        body: "Some description\n[since: 476]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("Stuck item (since cycle 476)");
    expect(joined).not.toContain("[since:");
    spy.mockRestore();
  });

  it("does NOT show '(since cycle N)' for Backlog or Up Next items (only In Progress)", () => {
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Backlog item",
        status: "Backlog",
        body: "Some body\n[since: 400]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    // Staleness label must not appear for non-In-Progress items
    expect(joined).not.toContain("since cycle");
    spy.mockRestore();
  });

  it("does NOT show '(since cycle N)' for In Progress items with empty body", () => {
    // When an In Progress item has an empty body, the [since: N] guard skips
    // parseInProgressSinceCycle entirely (item.body is falsy), so no sinceLabel
    // is appended. This pins that branch explicitly.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Active item",
        status: "In Progress",
        body: "",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("Active item");
    expect(joined).not.toContain("since cycle");
    spy.mockRestore();
  });

  it("omits body display entirely when body is only a [since: N] annotation", () => {
    // An item with no real body — only the staleness annotation — should emit no body lines.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Annotation-only item",
        status: "In Progress",
        body: "[since: 334]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("Annotation-only item");
    expect(joined).not.toContain("[since:");
    spy.mockRestore();
  });

  it("strips …[truncated] storage marker from body before CLI display", () => {
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Truncated body item",
        status: "Backlog",
        body: "Some important description …[truncated]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("Some important description");
    expect(joined).not.toContain("…[truncated]");
    spy.mockRestore();
  });

  it("strips …[truncated] marker even when combined with a [since: N] annotation", () => {
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Combined annotation item",
        status: "In Progress",
        body: "Real content\n[since: 400] …[truncated]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("Real content");
    expect(joined).not.toContain("[since:");
    expect(joined).not.toContain("[truncated]");
    spy.mockRestore();
  });

  it("does not truncate real content that only exceeds 120 chars because of a …[truncated] storage marker", () => {
    // The strip-then-truncate order matters: if the body is
    //   realContent (115 chars) + " …[truncated]" (14 chars) = 129 chars
    // stripping first reduces it to 115 chars (under the 120-char limit),
    // so no display ellipsis should be appended.  If truncation ran first,
    // the 129-char raw body would be sliced to 120 chars and then "…" appended
    // even though the actual useful content comfortably fits within the limit.
    const realContent = "r".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS - 5); // 115 chars
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Strip-before-truncate item",
        status: "Backlog",
        body: `${realContent} …[truncated]`,
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    // The real content must appear in full (it is under the 120-char limit once stripped)
    expect(joined).toContain("r".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS - 5));
    // The storage marker must be gone
    expect(joined).not.toContain("…[truncated]");
    // No display ellipsis should be appended — stripping brought the body under the limit
    expect(joined).not.toContain("r".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS - 5) + "…");
    spy.mockRestore();
  });

  it("still truncates when real content alone exceeds 120 chars, even if …[truncated] marker is also present", () => {
    // A body with realContent (130 chars) + " …[truncated]": after stripping
    // the real content is still over 120, so the display ellipsis must appear.
    const realContent = "s".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS + 10); // 130 chars
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Over-limit after strip item",
        status: "Backlog",
        body: `${realContent} …[truncated]`,
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    // Storage marker must be gone
    expect(joined).not.toContain("…[truncated]");
    // Display ellipsis must appear because stripped body (130 chars) > 120 chars
    expect(joined).toContain("s".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS) + "…");
    // Full 130-char content must not appear
    expect(joined).not.toContain("s".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS + 10));
    spy.mockRestore();
  });

  it("silently skips items with null status without throwing", () => {
    // ProjectItem.status is typed as StatusColumn | null. Items with null status
    // do not match any STATUS_ORDER entry and must be silently dropped from output
    // without causing a crash or rendering a malformed section header.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Orphan item",
        status: null as unknown as planning.StatusColumn,
        body: "",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    // Null-status item title must not appear in output (silently dropped)
    expect(joined).not.toContain("Orphan item");
    // Output must still be valid (no crash) — header banner is always present
    expect(joined).toContain("Bloom Evolution Roadmap");
    spy.mockRestore();
  });

  it("shows 'No items on the roadmap yet.' when all items have null status", () => {
    // items.length > 0 but every item is invisible (null status) —
    // the "No items" fallback should still show to avoid a blank roadmap display.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Hidden item",
        status: null as unknown as planning.StatusColumn,
        body: "",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    // No status sections should have been rendered
    expect(joined).not.toContain("BACKLOG");
    expect(joined).not.toContain("UP NEXT");
    // The fallback message must appear so users see something useful rather than a blank roadmap
    expect(joined).toContain("No items on the roadmap yet.");
    spy.mockRestore();
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

describe("generateRoadmapJson", () => {
  it("returns an object with an items array", () => {
    const result = generateRoadmapJson(SAMPLE_ROADMAP);
    expect(result).toHaveProperty("items");
    expect(Array.isArray(result.items)).toBe(true);
  });

  it("items array contains parsed ProjectItem objects from the roadmap", () => {
    const result = generateRoadmapJson(SAMPLE_ROADMAP);
    const titles = result.items.map((i) => i.title);
    expect(titles).toContain("Improve prompt efficiency");
    expect(titles).toContain("Write more tests");
    expect(titles).toContain("Track token usage");
  });

  it("returns empty items array for an empty roadmap", () => {
    const result = generateRoadmapJson(EMPTY_ROADMAP);
    expect(result.items).toHaveLength(0);
  });

  it("result is JSON-serialisable (no undefined or circular values)", () => {
    const result = generateRoadmapJson(SAMPLE_ROADMAP);
    expect(() => JSON.stringify(result)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(result));
    expect(Array.isArray(parsed.items)).toBe(true);
  });

  it("each item has the expected ProjectItem shape", () => {
    const result = generateRoadmapJson(SAMPLE_ROADMAP);
    for (const item of result.items) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.title).toBe("string");
      expect(typeof item.body).toBe("string");
      expect(typeof item.reactions).toBe("number");
    }
  });

  it("each item has a sinceCycle field that is a number or null", () => {
    const result = generateRoadmapJson(SAMPLE_ROADMAP);
    for (const item of result.items) {
      expect(item.sinceCycle === null || typeof item.sinceCycle === "number").toBe(true);
    }
  });

  it("strips [since: N] annotation from body in JSON output", () => {
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "In-progress item",
        status: "In Progress",
        body: "Real description\n[since: 42]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const result = generateRoadmapJson("");
    expect(result.items[0].body).toBe("Real description");
    expect(result.items[0].body).not.toContain("[since:");
    spy.mockRestore();
  });

  it("populates sinceCycle for In Progress items with a [since: N] annotation", () => {
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Stuck item",
        status: "In Progress",
        body: "Some work\n[since: 330]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const result = generateRoadmapJson("");
    expect(result.items[0].sinceCycle).toBe(330);
    spy.mockRestore();
  });

  it("sets sinceCycle to null for non-In-Progress items even with a [since: N] annotation", () => {
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Backlog item",
        status: "Backlog",
        body: "Some body\n[since: 10]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const result = generateRoadmapJson("");
    expect(result.items[0].sinceCycle).toBeNull();
    spy.mockRestore();
  });

  it("sets sinceCycle to null for In Progress items with no [since: N] annotation", () => {
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Fresh item",
        status: "In Progress",
        body: "Just started",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const result = generateRoadmapJson("");
    expect(result.items[0].sinceCycle).toBeNull();
    spy.mockRestore();
  });

  it("propagates large future-cycle [since: N] annotations as-is (no currentCycle filtering)", () => {
    // generateRoadmapJson calls parseInProgressSinceCycle without a currentCycle
    // argument, so future-cycle values like 99999 are NOT filtered — they pass
    // through as the raw number, not null. This test documents that contract.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Future-annotated item",
        status: "In Progress",
        body: "Work in progress\n[since: 99999]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const result = generateRoadmapJson("");
    expect(result.items[0].sinceCycle).toBe(99999);
    spy.mockRestore();
  });

  it("strips …[truncated] storage marker from body in JSON output", () => {
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Long item",
        status: "Backlog",
        body: "Real content …[truncated]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const result = generateRoadmapJson("");
    expect(result.items[0].body).toBe("Real content");
    expect(result.items[0].body).not.toContain("…[truncated]");
    spy.mockRestore();
  });

  it("strips both [since: N] and …[truncated] markers together", () => {
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Combined item",
        status: "In Progress",
        body: "Some work\n[since: 400] …[truncated]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const result = generateRoadmapJson("");
    expect(result.items[0].body).not.toContain("[since:");
    expect(result.items[0].body).not.toContain("[truncated]");
    expect(result.items[0].sinceCycle).toBe(400);
    spy.mockRestore();
  });

  it("includes a summary field with total and byStatus", () => {
    const result = generateRoadmapJson(SAMPLE_ROADMAP);
    expect(result).toHaveProperty("summary");
    const summary = result.summary as RoadmapJsonSummary;
    expect(typeof summary.total).toBe("number");
    expect(typeof summary.byStatus).toBe("object");
  });

  it("summary.total equals items.length", () => {
    const result = generateRoadmapJson(SAMPLE_ROADMAP);
    expect(result.summary.total).toBe(result.items.length);
  });

  it("summary.total is 0 for an empty roadmap", () => {
    const result = generateRoadmapJson(EMPTY_ROADMAP);
    expect(result.summary.total).toBe(0);
    expect(result.summary.byStatus).toEqual({});
  });

  it("summary.byStatus counts items per status correctly", () => {
    // SAMPLE_ROADMAP: 2 Backlog, 1 Up Next, 1 In Progress, 1 Done
    const result = generateRoadmapJson(SAMPLE_ROADMAP);
    expect(result.summary.byStatus["Backlog"]).toBe(2);
    expect(result.summary.byStatus["Up Next"]).toBe(1);
    expect(result.summary.byStatus["In Progress"]).toBe(1);
    expect(result.summary.byStatus["Done"]).toBe(1);
  });

  it("null-status items are counted in summary.total but excluded from summary.byStatus", () => {
    // Items whose section heading does not map to a known StatusColumn get
    // status: null from the parser. These are included in `total` (all items)
    // but excluded from `byStatus` (per-status breakdown), so total can exceed
    // sum(byStatus.values). This test pins that intentional divergence.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Normal item",
        status: "Backlog",
        body: "",
        linkedIssueNumber: null,
        reactions: 0,
      },
      {
        id: "item-1",
        title: "Orphan item",
        status: null as unknown as planning.StatusColumn,
        body: "",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const result = generateRoadmapJson("");
    // total counts both items (including null-status)
    expect(result.summary.total).toBe(2);
    // byStatus only counts the known-status item
    expect(result.summary.byStatus["Backlog"]).toBe(1);
    // null-status item must NOT appear as a key in byStatus
    const byStatusKeys = Object.keys(result.summary.byStatus);
    expect(byStatusKeys).not.toContain("null");
    expect(byStatusKeys).toHaveLength(1);
    spy.mockRestore();
  });

  it("items are sorted by STATUS_ORDER (In Progress first, then Up Next, Backlog, Done)", () => {
    const result = generateRoadmapJson(SAMPLE_ROADMAP);
    const statuses = result.items.map((i) => i.status);
    const inProgressIdx = statuses.indexOf("In Progress");
    const upNextIdx = statuses.indexOf("Up Next");
    const backlogIdx = statuses.indexOf("Backlog");
    const doneIdx = statuses.indexOf("Done");
    expect(inProgressIdx).toBeLessThan(upNextIdx);
    expect(upNextIdx).toBeLessThan(backlogIdx);
    expect(backlogIdx).toBeLessThan(doneIdx);
  });

  it("null-status items sort after all known-status items in the output array", () => {
    // The statusRank lookup returns STATUS_ORDER.length for null-status items,
    // which is the highest rank value — placing them at the end. A regression
    // that changed the fallback (e.g. returning 0 or -1) would silently reorder
    // them to the front; this test pins their position.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Orphan item",
        status: null as unknown as planning.StatusColumn,
        body: "",
        linkedIssueNumber: null,
        reactions: 0,
      },
      {
        id: "item-1",
        title: "Backlog item",
        status: "Backlog",
        body: "",
        linkedIssueNumber: null,
        reactions: 0,
      },
      {
        id: "item-2",
        title: "Done item",
        status: "Done",
        body: "",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const result = generateRoadmapJson("");
    const titles = result.items.map((i) => i.title);
    const orphanIdx = titles.indexOf("Orphan item");
    const backlogIdx = titles.indexOf("Backlog item");
    const doneIdx = titles.indexOf("Done item");
    // null-status item must appear after both known-status items
    expect(orphanIdx).toBeGreaterThan(backlogIdx);
    expect(orphanIdx).toBeGreaterThan(doneIdx);
    spy.mockRestore();
  });

  it("summary is JSON-serialisable (no undefined or circular values)", () => {
    const result = generateRoadmapJson(SAMPLE_ROADMAP);
    expect(() => JSON.stringify(result.summary)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(result.summary));
    expect(typeof parsed.total).toBe("number");
    expect(typeof parsed.byStatus).toBe("object");
  });

  it("filterStatus=undefined returns all items (existing behaviour unchanged)", () => {
    const result = generateRoadmapJson(SAMPLE_ROADMAP, undefined);
    // SAMPLE_ROADMAP has 5 items: 2 Backlog, 1 Up Next, 1 In Progress, 1 Done
    expect(result.items).toHaveLength(5);
    expect(result.summary.total).toBe(5);
  });

  it("filterStatus='Backlog' returns only Backlog items", () => {
    const result = generateRoadmapJson(SAMPLE_ROADMAP, "Backlog");
    expect(result.items.every((i) => i.status === "Backlog")).toBe(true);
    expect(result.items).toHaveLength(2);
  });

  it("filterStatus='Backlog' summary reflects only the filtered subset", () => {
    const result = generateRoadmapJson(SAMPLE_ROADMAP, "Backlog");
    expect(result.summary.total).toBe(2);
    expect(result.summary.byStatus["Backlog"]).toBe(2);
    expect(result.summary.byStatus["In Progress"]).toBeUndefined();
    expect(result.summary.byStatus["Done"]).toBeUndefined();
  });

  it("filterStatus='In Progress' returns only In Progress items", () => {
    const result = generateRoadmapJson(SAMPLE_ROADMAP, "In Progress");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Write more tests");
    expect(result.summary.total).toBe(1);
    expect(result.summary.byStatus["In Progress"]).toBe(1);
  });

  it("filterStatus that matches no items returns empty items array and zero total", () => {
    // EMPTY_ROADMAP has no items at all — filter result must be empty
    const result = generateRoadmapJson(EMPTY_ROADMAP, "Backlog");
    expect(result.items).toHaveLength(0);
    expect(result.summary.total).toBe(0);
    expect(result.summary.byStatus).toEqual({});
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

  it("assigns section status (not 'Done') to a [x] checkbox item under a non-Done heading", () => {
    // Status comes from the ## heading, not the [ ]/[x] checkbox state.
    // A checked item under ## Backlog must parse as status "Backlog", not "Done".
    const content = `# Bloom Evolution Roadmap

## Backlog
- [x] Accidentally-checked backlog item
`;
    const items = parseRoadmap(content);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("Backlog");
    expect(items[0].title).toBe("Accidentally-checked backlog item");
  });
});

describe("serializeRoadmap + parseRoadmap round-trip", () => {
  it("round-trips an item with a single-line body", () => {
    const content = `# Bloom Evolution Roadmap\n\n## Backlog\n- [ ] My item\n  Some body text.\n`;
    const items = parseRoadmap(content);
    expect(items).toHaveLength(1);
    expect(items[0].body).toBe("Some body text.");
    const serialized = serializeRoadmap(items);
    const reparsed = parseRoadmap(serialized);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].title).toBe(items[0].title);
    expect(reparsed[0].body).toBe(items[0].body);
    expect(reparsed[0].status).toBe(items[0].status);
  });

  it("round-trips an item with a multi-line body (non-blank lines preserved)", () => {
    const content = `# Bloom Evolution Roadmap\n\n## Backlog\n- [ ] Multi-line item\n  First line.\n  Second line.\n  Third line.\n`;
    const items = parseRoadmap(content);
    expect(items).toHaveLength(1);
    expect(items[0].body).toBe("First line.\nSecond line.\nThird line.");
    const serialized = serializeRoadmap(items);
    const reparsed = parseRoadmap(serialized);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].body).toBe("First line.\nSecond line.\nThird line.");
  });

  it("documents that blank embedded body lines are dropped during parse (known lossy behavior)", () => {
    // serializeRoadmap emits blank body lines as "  " (two spaces), but parseRoadmap
    // guards with `&& line.trim()`, so whitespace-only indented lines are silently dropped.
    const content = `# Bloom Evolution Roadmap\n\n## Backlog\n- [ ] Item with blank body line\n  Line one.\n\n  Line two.\n`;
    const items = parseRoadmap(content);
    expect(items).toHaveLength(1);
    // The blank line between "Line one." and "Line two." is dropped
    expect(items[0].body).toBe("Line one.\nLine two.");
  });
});

describe("parseRoadmapFilterFlag", () => {
  it("returns undefined when --filter is absent", () => {
    expect(parseRoadmapFilterFlag(["node", "roadmap.js"])).toBeUndefined();
  });

  it("returns undefined when --filter is present but has no value", () => {
    expect(parseRoadmapFilterFlag(["node", "roadmap.js", "--filter"])).toBeUndefined();
  });

  it("returns undefined when the value does not match a known status", () => {
    expect(parseRoadmapFilterFlag(["node", "roadmap.js", "--filter", "unknown"])).toBeUndefined();
  });

  it("returns 'Backlog' for --filter backlog (case-insensitive)", () => {
    expect(parseRoadmapFilterFlag(["--filter", "backlog"])).toBe("Backlog");
    expect(parseRoadmapFilterFlag(["--filter", "BACKLOG"])).toBe("Backlog");
    expect(parseRoadmapFilterFlag(["--filter", "Backlog"])).toBe("Backlog");
  });

  it("returns 'In Progress' for --filter 'in progress'", () => {
    expect(parseRoadmapFilterFlag(["--filter", "in progress"])).toBe("In Progress");
  });

  it("returns 'Done' for --filter done", () => {
    expect(parseRoadmapFilterFlag(["--filter", "done"])).toBe("Done");
  });

  it("returns 'Up Next' for --filter 'up next'", () => {
    expect(parseRoadmapFilterFlag(["--filter", "up next"])).toBe("Up Next");
  });

  it("returns undefined when the token after --filter is itself a flag (e.g. --json)", () => {
    // "--json" does not match any known status, so the flag value is treated as
    // an unrecognised status and the function correctly returns undefined rather
    // than consuming the adjacent flag as a filter value.
    expect(parseRoadmapFilterFlag(["--filter", "--json"])).toBeUndefined();
  });
});

describe("generateRoadmapOutput --filter", () => {
  it("shows only backlog items when filterStatus is 'Backlog'", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP, "Backlog");
    const joined = output.join("\n");
    expect(joined).toContain("Improve prompt efficiency");
    expect(joined).not.toContain("Write more tests");  // In Progress
    expect(joined).not.toContain("Track token usage");  // Done
    expect(joined).not.toContain("Add error classification"); // Up Next
  });

  it("shows only In Progress items when filterStatus is 'In Progress'", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP, "In Progress");
    const joined = output.join("\n");
    expect(joined).toContain("Write more tests");
    expect(joined).not.toContain("Improve prompt efficiency");
    expect(joined).not.toContain("Track token usage");
  });

  it("shows only Done items when filterStatus is 'Done'", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP, "Done");
    const joined = output.join("\n");
    expect(joined).toContain("Track token usage");
    expect(joined).not.toContain("Write more tests");
    expect(joined).not.toContain("Improve prompt efficiency");
  });

  it("shows only Up Next items when filterStatus is 'Up Next'", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP, "Up Next");
    const joined = output.join("\n");
    expect(joined).toContain("Add error classification");
    expect(joined).not.toContain("Write more tests");       // In Progress
    expect(joined).not.toContain("Improve prompt efficiency"); // Backlog
    expect(joined).not.toContain("Track token usage");      // Done
  });

  it("shows status-specific message when filterStatus matches no items", () => {
    // EMPTY_ROADMAP has no items in any category — the filter-specific fallback
    // should name the requested status rather than the generic "yet." message.
    const output = generateRoadmapOutput(EMPTY_ROADMAP, "Backlog");
    const joined = output.join("\n");
    expect(joined).toContain("No Backlog items on the roadmap.");
    expect(joined).not.toContain("No items on the roadmap yet.");
  });

  it("shows all items when filterStatus is undefined", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("Improve prompt efficiency");
    expect(joined).toContain("Write more tests");
    expect(joined).toContain("Track token usage");
  });
});
