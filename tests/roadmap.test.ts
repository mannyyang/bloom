import { describe, it, expect, vi } from "vitest";
import { generateRoadmapOutput, generateRoadmapJson, generateRoadmapMarkdown, generateRoadmapCsv, parseRoadmapFilterFlag, parseFormatFlag, ROADMAP_BODY_PREVIEW_MAX_CHARS, ROADMAP_HELP_TEXT, STATUS_ORDER, type RoadmapJsonSummary } from "../src/roadmap.js";
import { parseHelpFlag } from "../src/stats.js";
import * as planning from "../src/planning.js";
import { parseRoadmap, serializeRoadmap, STATUS_COLUMNS, ITEM_BODY_LIMIT, PLANNING_BODY_PREVIEW_CHARS } from "../src/planning.js";

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

  it("shows an 'Items:' summary line when the roadmap has items", () => {
    // SAMPLE_ROADMAP: 1 in progress, 1 up next, 2 backlog, 1 done
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("Items:");
  });

  it("summary line lists counts for each status present (case-lower, dot-separated)", () => {
    // SAMPLE_ROADMAP: 2 Backlog, 1 Up Next, 1 In Progress, 1 Done
    // STATUS_ORDER renders In Progress first, so the expected order is:
    //   1 in progress · 1 up next · 2 backlog · 1 done
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("1 in progress · 1 up next · 2 backlog · 1 done");
  });

  it("summary line is omitted for an empty roadmap (zero items)", () => {
    const output = generateRoadmapOutput(EMPTY_ROADMAP);
    const joined = output.join("\n");
    // No summary line should appear — the "No items" fallback covers the empty case
    expect(joined).not.toContain("Items:");
  });

  it("summary line only lists statuses that have at least one item", () => {
    // A roadmap with only Backlog items must not show 'in progress', 'up next', or 'done'
    const backlogOnly = `# Bloom Evolution Roadmap\n\n## Backlog\n- [ ] Item A\n- [ ] Item B\n\n## Up Next\n\n## In Progress\n\n## Done\n`;
    const output = generateRoadmapOutput(backlogOnly);
    const joined = output.join("\n");
    expect(joined).toContain("Items: 2 backlog");
    expect(joined).not.toContain("in progress");
    expect(joined).not.toContain("up next");
    expect(joined).not.toContain("done");
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

  it("propagates large future-cycle [since: N] annotations as-is when no currentCycle is passed", () => {
    // Without a currentCycle argument, parseInProgressSinceCycle has no upper
    // bound and returns the raw number for any valid positive integer.
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

  it("rejects future-cycle [since: N] annotation when currentCycle is provided", () => {
    // When currentCycle is passed through, parseInProgressSinceCycle rejects
    // values where N > currentCycle, returning null instead of the raw number.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Future-annotated item",
        status: "In Progress",
        body: "Work in progress\n[since: 9999]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const result = generateRoadmapJson("", undefined, 10);
    expect(result.items[0].sinceCycle).toBeNull();
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

  it("same-status items are sorted alphabetically by title as a stable tiebreaker", () => {
    // When two items share the same status their relative order must be
    // determined by title (localeCompare), not by parse order.  A regression
    // that removed the tiebreaker would make CI diffs non-deterministic.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      { id: "b", title: "Zebra task", status: "Backlog", body: "", linkedIssueNumber: null, reactions: 0 },
      { id: "a", title: "Alpha task", status: "Backlog", body: "", linkedIssueNumber: null, reactions: 0 },
      { id: "c", title: "Middle task", status: "Backlog", body: "", linkedIssueNumber: null, reactions: 0 },
    ]);
    const result = generateRoadmapJson("");
    spy.mockRestore();
    const titles = result.items.map((i) => i.title);
    expect(titles).toEqual(["Alpha task", "Middle task", "Zebra task"]);
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

  it("strips [since: N] annotation from body when filterStatus is active", () => {
    // Combinatorial pin: filterStatus + body-stripping must both fire together.
    // generateRoadmapJson calls cleanItemBody on every item; this test pins that
    // the cleaning still occurs when a filterStatus is supplied, preventing a
    // refactor from skipping cleanItemBody in the filtered path.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "In Progress item",
        status: "In Progress",
        body: "Real description [since: 42]",
        linkedIssueNumber: null,
        reactions: 0,
      },
      {
        id: "item-1",
        title: "Backlog item",
        status: "Backlog",
        body: "Backlog body",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const result = generateRoadmapJson(SAMPLE_ROADMAP, "In Progress");
    spy.mockRestore();
    // Only the In Progress item should be returned
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("In Progress item");
    // The [since: N] annotation must be stripped from the body
    expect(result.items[0].body).toBe("Real description");
    expect(result.items[0].body).not.toContain("[since: 42]");
    // sinceCycle must be correctly extracted from the annotation
    expect(result.items[0].sinceCycle).toBe(42);
  });

  it("combined filterStatus='In Progress' + currentCycle: valid since annotation is kept", () => {
    // When both params are active together, filterStatus reduces to only In Progress
    // items AND currentCycle bounds the sinceCycle extraction. A valid [since: N]
    // where N <= currentCycle should still be returned correctly.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Active item",
        status: "In Progress",
        body: "Work in progress\n[since: 5]",
        linkedIssueNumber: null,
        reactions: 0,
      },
      {
        id: "item-1",
        title: "Backlog item",
        status: "Backlog",
        body: "Waiting",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const result = generateRoadmapJson("", "In Progress", 10);
    spy.mockRestore();
    // filterStatus path: only In Progress item is returned
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Active item");
    // currentCycle path: N=5 <= 10 so sinceCycle is preserved
    expect(result.items[0].sinceCycle).toBe(5);
    // body cleaning still fires alongside both filters
    expect(result.items[0].body).not.toContain("[since:");
  });

  it("combined filterStatus='In Progress' + currentCycle: future-cycle annotation is rejected", () => {
    // Both paths must coexist without either short-circuiting the other.
    // filterStatus keeps only In Progress items; currentCycle rejects N > currentCycle.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Future-annotated item",
        status: "In Progress",
        body: "Stale work\n[since: 9999]",
        linkedIssueNumber: null,
        reactions: 0,
      },
      {
        id: "item-1",
        title: "Backlog item",
        status: "Backlog",
        body: "Queued",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const result = generateRoadmapJson("", "In Progress", 10);
    spy.mockRestore();
    // filterStatus: only the In Progress item is included
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Future-annotated item");
    // currentCycle: N=9999 > 10, so sinceCycle is null
    expect(result.items[0].sinceCycle).toBeNull();
    // body cleaning still strips the annotation
    expect(result.items[0].body).not.toContain("[since:");
  });

  it("combined filterStatus='Done' + currentCycle: Done items always have null sinceCycle", () => {
    // sinceCycle is only populated for In Progress items. Done items always return
    // null regardless of currentCycle. This combination verifies that passing
    // currentCycle does not accidentally populate sinceCycle for non-In Progress items.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Completed item",
        status: "Done",
        body: "Finished\n[since: 3]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const result = generateRoadmapJson("", "Done", 10);
    spy.mockRestore();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Completed item");
    // Done items: sinceCycle is always null, even when currentCycle is passed
    expect(result.items[0].sinceCycle).toBeNull();
    // summary total reflects the filtered Done subset
    expect(result.summary.total).toBe(1);
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

  it("items under an unrecognised ## heading are silently dropped (not assigned null status)", () => {
    // parseRoadmap sets currentStatus = null for unknown headings and then
    // guards `if (itemMatch && currentStatus)` — a falsy null currentStatus
    // means those items are never pushed to the result array.
    // This pins the documented "silently dropped" behaviour so a future
    // refactor that accidentally includes them (changing byStatus or total
    // counts) is caught immediately.
    const content = `# Bloom Evolution Roadmap

## Backlog
- [ ] Known item

## Custom Section
- [ ] Should be silently dropped
`;
    const items = parseRoadmap(content);
    // Only the item under a recognised ## heading should be returned
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Known item");
    expect(items[0].status).toBe("Backlog");
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

  it("handles CRLF in item body without producing trailing \\r in output", () => {
    // Regression guard for the CRLF bug: if item.body contains \r\n line endings
    // (e.g. from a completionNote that wasn't normalized before storage), the
    // serialized output must not contain any \r characters.
    const items = parseRoadmap(
      `# Bloom Evolution Roadmap\n\n## Backlog\n- [ ] CRLF item\n  Line one.\n`,
    );
    expect(items).toHaveLength(1);
    // Inject CRLF into the body to simulate the bug scenario
    items[0].body = "Line one.\r\nLine two.";
    const serialized = serializeRoadmap(items);
    expect(serialized).not.toContain("\r");
    // Must also round-trip cleanly through parseRoadmap
    const reparsed = parseRoadmap(serialized);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].body).toBe("Line one.\nLine two.");
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

  it("returns undefined for --filter 'in' (partial match of 'In Progress' is not accepted)", () => {
    // CLI tokenisation splits on spaces, so "in progress" arrives as a single
    // argv slot only when the caller quotes it.  "in" alone does not match any
    // status and must return undefined rather than silently matching nothing.
    expect(parseRoadmapFilterFlag(["--filter", "in"])).toBeUndefined();
  });

  it("returns undefined for --filter 'progress' (second word of 'In Progress' alone)", () => {
    // Symmetric guard: the second word of a multi-word status must also not match.
    expect(parseRoadmapFilterFlag(["--filter", "progress"])).toBeUndefined();
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

  it("returns 'Up Next' when shell splits 'up next' into two argv tokens", () => {
    // When a user runs: pnpm roadmap --filter up next (without quotes), the shell
    // passes ["--filter", "up", "next"]. The fallback join handles this case.
    expect(parseRoadmapFilterFlag(["--filter", "up", "next"])).toBe("Up Next");
  });

  it("returns 'In Progress' when shell splits 'in progress' into two argv tokens", () => {
    expect(parseRoadmapFilterFlag(["--filter", "in", "progress"])).toBe("In Progress");
  });

  it("split-token match is case-insensitive ('UP', 'NEXT' → 'Up Next')", () => {
    expect(parseRoadmapFilterFlag(["--filter", "UP", "NEXT"])).toBe("Up Next");
  });

  it("split-token fallback does not consume the next token when single token already matches", () => {
    // When argv[idx+1] already matches (e.g. "backlog"), argv[idx+2] must be
    // ignored — the fallback join must never run for unambiguous single-word statuses.
    expect(parseRoadmapFilterFlag(["--filter", "backlog", "extra"])).toBe("Backlog");
  });

  it("two-token fallback still returns correct status when --json follows the two tokens", () => {
    // pnpm roadmap --filter up next --json: the shell produces
    // ["--filter", "up", "next", "--json"].  argv[idx+2] is "next" (not "--json"),
    // so the combined "up next" → "Up Next" is returned and --json is not consumed.
    expect(parseRoadmapFilterFlag(["--filter", "up", "next", "--json"])).toBe("Up Next");
    expect(parseRoadmapFilterFlag(["--filter", "in", "progress", "--json"])).toBe("In Progress");
  });

  it("two-token fallback returns undefined when --json occupies argv[idx+2] (no valid status)", () => {
    // pnpm roadmap --filter up --json: argv[idx+2] is "--json", so the combined
    // "up --json" does not match any known status.  The function must return undefined
    // rather than misidentifying --json as the second word of a multi-word status.
    expect(parseRoadmapFilterFlag(["--filter", "up", "--json"])).toBeUndefined();
    expect(parseRoadmapFilterFlag(["--filter", "in", "--json"])).toBeUndefined();
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

  it("shows status-specific message when filterStatus='Done' but roadmap has no Done items (non-empty roadmap)", () => {
    // Distinct branch from the EMPTY_ROADMAP case: the roadmap has items in
    // Backlog and Up Next but zero Done items. Filtering by 'Done' should emit
    // the status-specific "No Done items on the roadmap." message, NOT the
    // generic "No items on the roadmap yet." that fires when the entire roadmap
    // is empty. Without this test a refactor could swap the two messages without
    // any test catching the regression.
    const noDoneRoadmap = [
      "# Bloom Evolution Roadmap",
      "",
      "## Backlog",
      "- [ ] A backlog idea",
      "",
      "## Up Next",
      "- [ ] An up-next item",
      "",
      "## In Progress",
      "",
      "## Done",
      "",
    ].join("\n");
    const output = generateRoadmapOutput(noDoneRoadmap, "Done");
    const joined = output.join("\n");
    expect(joined).toContain("No Done items on the roadmap.");
    expect(joined).not.toContain("No items on the roadmap yet.");
    // Items from other sections must not bleed through
    expect(joined).not.toContain("A backlog idea");
    expect(joined).not.toContain("An up-next item");
  });

  it("shows all items when filterStatus is undefined", () => {
    const output = generateRoadmapOutput(SAMPLE_ROADMAP);
    const joined = output.join("\n");
    expect(joined).toContain("Improve prompt efficiency");
    expect(joined).toContain("Write more tests");
    expect(joined).toContain("Track token usage");
  });

  it("renders body of a filtered Backlog item that has a non-empty body", () => {
    // Combinatorial gap: filtering + body rendering together. Ensures a future
    // refactor that clears item.body before the render loop does not silently
    // drop body content when filterStatus is active.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Backlog item with body",
        status: "Backlog",
        body: "This is a meaningful description",
        linkedIssueNumber: null,
        reactions: 0,
      },
      {
        id: "item-1",
        title: "In Progress item",
        status: "In Progress",
        body: "",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP, "Backlog");
    const joined = output.join("\n");
    // The Backlog item title must appear
    expect(joined).toContain("Backlog item with body");
    // The body of the Backlog item must appear indented
    expect(joined).toContain("This is a meaningful description");
    // The In Progress item must be excluded by the filter
    expect(joined).not.toContain("In Progress item");
    spy.mockRestore();
  });

  it("summary line reflects only the filtered subset when filterStatus is active", () => {
    // Bug regression: previously the summary was built from all items even when
    // filterStatus was set, so --filter backlog printed a summary showing all
    // statuses while only rendering backlog items — inconsistent with JSON output.
    // After the fix the summary must scope to the filtered items.
    const output = generateRoadmapOutput(SAMPLE_ROADMAP, "Backlog");
    const joined = output.join("\n");
    // Summary should show only backlog counts (SAMPLE_ROADMAP has 2 Backlog items)
    expect(joined).toContain("Items: 2 backlog");
    // Other statuses must NOT appear in the summary
    expect(joined).not.toContain("in progress");
    expect(joined).not.toContain("up next");
    expect(joined).not.toContain("done");
  });

  it("truncates body longer than ROADMAP_BODY_PREVIEW_MAX_CHARS when filterStatus is active", () => {
    // Combinatorial pin: filterStatus + truncation must both fire together.
    // A refactor that clears body or skips truncation only when a filter is
    // active would pass the non-filter truncation tests but fail here.
    const longBody = "a".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS + 20);
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Filtered item with long body",
        status: "Backlog",
        body: longBody,
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const output = generateRoadmapOutput(SAMPLE_ROADMAP, "Backlog");
    const joined = output.join("\n");
    spy.mockRestore();
    // Title must appear
    expect(joined).toContain("Filtered item with long body");
    // Output must include first ROADMAP_BODY_PREVIEW_MAX_CHARS chars
    expect(joined).toContain("a".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS));
    // Output must NOT include more than ROADMAP_BODY_PREVIEW_MAX_CHARS chars of body
    expect(joined).not.toContain("a".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS + 1));
    // Ellipsis must be appended
    expect(joined).toContain("a".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS) + "…");
  });
});

describe("parseFormatFlag", () => {
  it("returns undefined when --format is absent", () => {
    expect(parseFormatFlag(["node", "roadmap.js"])).toBeUndefined();
  });

  it("returns 'md' when --format md is present", () => {
    expect(parseFormatFlag(["node", "roadmap.js", "--format", "md"])).toBe("md");
  });

  it("returns undefined when --format has an unrecognised value", () => {
    expect(parseFormatFlag(["node", "roadmap.js", "--format", "html"])).toBeUndefined();
  });

  it("returns undefined when --format is present with no following value", () => {
    expect(parseFormatFlag(["node", "roadmap.js", "--format"])).toBeUndefined();
  });

  it("returns undefined for an empty argv", () => {
    expect(parseFormatFlag([])).toBeUndefined();
  });
});

describe("generateRoadmapMarkdown", () => {
  it("returns a string starting with the h1 title", () => {
    const md = generateRoadmapMarkdown(SAMPLE_ROADMAP);
    expect(md.startsWith("# Bloom Evolution Roadmap")).toBe(true);
  });

  it("renders each status as an h2 section heading", () => {
    const md = generateRoadmapMarkdown(SAMPLE_ROADMAP);
    expect(md).toContain("## In Progress");
    expect(md).toContain("## Up Next");
    expect(md).toContain("## Backlog");
    expect(md).toContain("## Done");
  });

  it("renders incomplete items as GFM unchecked checkboxes", () => {
    const md = generateRoadmapMarkdown(SAMPLE_ROADMAP);
    expect(md).toContain("- [ ] Write more tests");
    expect(md).toContain("- [ ] Add error classification");
  });

  it("renders Done items as GFM checked checkboxes", () => {
    const md = generateRoadmapMarkdown(SAMPLE_ROADMAP);
    expect(md).toContain("- [x] Track token usage");
  });

  it("includes issue number in the item line when present", () => {
    const md = generateRoadmapMarkdown(SAMPLE_ROADMAP);
    expect(md).toContain("(#8)");
    expect(md).toContain("(#4)");
  });

  it("omits reactions badge when reactions are zero", () => {
    // SAMPLE_ROADMAP items have 0 reactions — the ★ badge must be absent
    const md = generateRoadmapMarkdown(SAMPLE_ROADMAP);
    expect(md).not.toContain("★");
  });

  it("renders [N ★] badge for items with reactions > 0", () => {
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
    const md = generateRoadmapMarkdown(SAMPLE_ROADMAP);
    expect(md).toContain("[7 ★]");
    spy.mockRestore();
  });

  it("filters by status when filterStatus is provided", () => {
    const md = generateRoadmapMarkdown(SAMPLE_ROADMAP, "Backlog");
    expect(md).toContain("## Backlog");
    expect(md).not.toContain("## In Progress");
    expect(md).not.toContain("## Done");
  });

  it("emits italic fallback when no items exist for the filtered status", () => {
    const md = generateRoadmapMarkdown(EMPTY_ROADMAP, "Backlog");
    expect(md).toContain("_No Backlog items on the roadmap._");
  });

  it("emits status-specific italic fallback for filterStatus='Done' on a roadmap with no Done items", () => {
    // Targets the branch: filterStatus provided + zero matching items in a non-empty roadmap.
    // SAMPLE_ROADMAP contains active items (Backlog, Up Next, In Progress, Done); we need
    // a roadmap that has items in active sections but an empty Done column to exercise
    // `_No Done items on the roadmap._` (vs the generic `_No items on the roadmap yet._`).
    const noDoneRoadmap = [
      "# Bloom Evolution Roadmap",
      "",
      "## Backlog",
      "- [ ] A backlog idea",
      "",
      "## Up Next",
      "- [ ] An up-next item",
      "",
      "## In Progress",
      "",
      "## Done",
      "",
    ].join("\n");
    const md = generateRoadmapMarkdown(noDoneRoadmap, "Done");
    expect(md).toContain("_No Done items on the roadmap._");
    expect(md).not.toContain("_No items on the roadmap yet._");
    // Active items in other sections must not bleed into the filtered output
    expect(md).not.toContain("A backlog idea");
    expect(md).not.toContain("An up-next item");
  });

  it("emits status-specific italic fallback for filterStatus='In Progress' on a roadmap with no In Progress items", () => {
    // Targets the same branch as the Done test above, but for the 'In Progress'
    // status. Each status hits the `_No ${filterStatus} items on the roadmap._`
    // path independently; a refactor that hard-coded only 'Done' would be caught.
    const noInProgressRoadmap = [
      "# Bloom Evolution Roadmap",
      "",
      "## Backlog",
      "- [ ] A backlog idea",
      "",
      "## Up Next",
      "- [ ] An up-next item",
      "",
      "## In Progress",
      "",
      "## Done",
      "- [x] A finished thing",
      "",
    ].join("\n");
    const md = generateRoadmapMarkdown(noInProgressRoadmap, "In Progress");
    expect(md).toContain("_No In Progress items on the roadmap._");
    expect(md).not.toContain("_No items on the roadmap yet._");
    expect(md).not.toContain("A backlog idea");
    expect(md).not.toContain("A finished thing");
  });

  it("emits status-specific italic fallback for filterStatus='Up Next' on a roadmap with no Up Next items", () => {
    // Targets the same branch for the 'Up Next' status, completing coverage of
    // all four StatusColumn values for the non-empty-roadmap / empty-target path.
    const noUpNextRoadmap = [
      "# Bloom Evolution Roadmap",
      "",
      "## Backlog",
      "- [ ] A backlog idea",
      "",
      "## Up Next",
      "",
      "## In Progress",
      "- [ ] Active work",
      "",
      "## Done",
      "- [x] A finished thing",
      "",
    ].join("\n");
    const md = generateRoadmapMarkdown(noUpNextRoadmap, "Up Next");
    expect(md).toContain("_No Up Next items on the roadmap._");
    expect(md).not.toContain("_No items on the roadmap yet._");
    expect(md).not.toContain("A backlog idea");
    expect(md).not.toContain("Active work");
    expect(md).not.toContain("A finished thing");
  });

  it("emits italic fallback when the roadmap is entirely empty", () => {
    const md = generateRoadmapMarkdown(EMPTY_ROADMAP);
    expect(md).toContain("_No items on the roadmap yet._");
  });

  it("includes body preview indented under the item", () => {
    const md = generateRoadmapMarkdown(SAMPLE_ROADMAP);
    // "Improve prompt efficiency" has a body "Target: reduce median cycle cost by ~20%."
    expect(md).toContain("  Target: reduce median cycle cost by ~20%.");
  });

  it("renders multi-line body with each line indented separately", () => {
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Multi-line item",
        status: "Backlog",
        body: "First line\nSecond line",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const md = generateRoadmapMarkdown(SAMPLE_ROADMAP);
    expect(md).toContain("  First line");
    expect(md).toContain("  Second line");
    spy.mockRestore();
  });

  it("respects ROADMAP_BODY_PREVIEW_MAX_CHARS truncation limit", () => {
    const longBody = "x".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS + 50);
    const roadmap = `# Bloom Evolution Roadmap\n\n## Backlog\n- [ ] Lengthy item\n  ${longBody}\n`;
    const md = generateRoadmapMarkdown(roadmap);
    expect(md).not.toContain("x".repeat(ROADMAP_BODY_PREVIEW_MAX_CHARS + 1));
    expect(md).toContain("…");
  });

  it("output is a string (not an array)", () => {
    expect(typeof generateRoadmapMarkdown(SAMPLE_ROADMAP)).toBe("string");
  });

  it("filterStatus keeps populated section and drops all other sections (multi-section roadmap)", () => {
    // Structural pin: when a multi-section roadmap has items in several columns,
    // filterStatus must render only the target section (with its items intact)
    // while completely omitting sections that have items in other columns.
    const multiSection = [
      "# Bloom Evolution Roadmap",
      "",
      "## In Progress",
      "- [ ] Active work",
      "",
      "## Up Next",
      "- [ ] Queued item",
      "",
      "## Backlog",
      "- [ ] Future idea",
      "",
      "## Done",
      "- [x] Finished thing",
      "",
    ].join("\n");

    const md = generateRoadmapMarkdown(multiSection, "Up Next");

    // The target section and its item must be present
    expect(md).toContain("## Up Next");
    expect(md).toContain("- [ ] Queued item");
    // Sections with items in other columns must be absent
    expect(md).not.toContain("## In Progress");
    expect(md).not.toContain("Active work");
    expect(md).not.toContain("## Backlog");
    expect(md).not.toContain("Future idea");
    expect(md).not.toContain("## Done");
    expect(md).not.toContain("Finished thing");
  });

  it("shows '(since cycle N)' on the title line for In Progress items with a [since: N] annotation", () => {
    // The [since: N] annotation in the body is translated to a human-readable
    // "(since cycle N)" suffix on the item's title line in Markdown output,
    // mirroring the behaviour of generateRoadmapOutput.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Stuck item",
        status: "In Progress",
        body: "Some description\n[since: 512]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const md = generateRoadmapMarkdown(SAMPLE_ROADMAP);
    expect(md).toContain("Stuck item (since cycle 512)");
    // The raw annotation must not appear in the output
    expect(md).not.toContain("[since:");
    spy.mockRestore();
  });

  it("does NOT show '(since cycle N)' for Backlog items even with a [since: N] annotation in body", () => {
    // Only In Progress items get the sinceLabel — other statuses must be unaffected.
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
    const md = generateRoadmapMarkdown(SAMPLE_ROADMAP);
    expect(md).not.toContain("since cycle");
    spy.mockRestore();
  });

  it("strips [since: N] annotation from the body preview in Markdown output", () => {
    // The annotation is planning metadata and must not appear in the indented
    // body preview, only the human-readable label on the title line.
    const spy = vi.spyOn(planning, "parseRoadmap").mockReturnValueOnce([
      {
        id: "item-0",
        title: "Active item",
        status: "In Progress",
        body: "Real work\n[since: 99]",
        linkedIssueNumber: null,
        reactions: 0,
      },
    ]);
    const md = generateRoadmapMarkdown(SAMPLE_ROADMAP);
    expect(md).toContain("Real work");
    expect(md).not.toContain("[since:");
    spy.mockRestore();
  });

  it("does NOT show '(since cycle N)' for In Progress items with no [since: N] annotation", () => {
    // Items without the staleness annotation must have no suffix.
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
    const md = generateRoadmapMarkdown(SAMPLE_ROADMAP);
    expect(md).toContain("Fresh item");
    expect(md).not.toContain("since cycle");
    spy.mockRestore();
  });
});

describe("ROADMAP_HELP_TEXT and parseHelpFlag", () => {
  it("ROADMAP_HELP_TEXT contains key flags", () => {
    expect(ROADMAP_HELP_TEXT).toContain("--filter");
    expect(ROADMAP_HELP_TEXT).toContain("--format");
    expect(ROADMAP_HELP_TEXT).toContain("--json");
    expect(ROADMAP_HELP_TEXT).toContain("--help");
    expect(ROADMAP_HELP_TEXT).toContain("-h");
  });

  it("ROADMAP_HELP_TEXT starts with Usage line", () => {
    expect(ROADMAP_HELP_TEXT.startsWith("Usage: pnpm roadmap")).toBe(true);
  });

  it("parseHelpFlag detects --help in roadmap argv", () => {
    expect(parseHelpFlag(["node", "roadmap.js", "--help"])).toBe(true);
    expect(parseHelpFlag(["node", "roadmap.js", "-h"])).toBe(true);
    expect(parseHelpFlag(["node", "roadmap.js", "--json"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// STATUS_ORDER structural guard
// ---------------------------------------------------------------------------

describe("STATUS_ORDER", () => {
  it("is a permutation of STATUS_COLUMNS (every status appears exactly once)", () => {
    // Guards against STATUS_ORDER omitting or duplicating a status column.
    // Without this test, STATUS_ORDER could silently drift (e.g., a new status
    // added to STATUS_COLUMNS but not to STATUS_ORDER) causing incorrect render
    // order without any test failure.
    expect([...STATUS_ORDER].sort()).toEqual([...STATUS_COLUMNS].sort());
  });
});

// ---------------------------------------------------------------------------
// generateRoadmapCsv
// ---------------------------------------------------------------------------

describe("generateRoadmapCsv", () => {
  it("returns header-only output for an empty roadmap", () => {
    const output = generateRoadmapCsv(EMPTY_ROADMAP);
    expect(output.trim()).toBe("title,status,linkedIssueNumber,reactions,sinceCycle,body");
  });

  it("includes the CSV header row as the first line", () => {
    const output = generateRoadmapCsv(SAMPLE_ROADMAP);
    const firstLine = output.split("\n")[0];
    expect(firstLine).toBe("title,status,linkedIssueNumber,reactions,sinceCycle,body");
  });

  it("produces one data row per roadmap item", () => {
    const output = generateRoadmapCsv(SAMPLE_ROADMAP);
    // SAMPLE_ROADMAP has 5 items; header + 5 data rows + trailing newline
    const lines = output.trimEnd().split("\n");
    expect(lines).toHaveLength(6); // 1 header + 5 items
  });

  it("includes item title in each row", () => {
    const output = generateRoadmapCsv(SAMPLE_ROADMAP);
    expect(output).toContain("Improve prompt efficiency");
    expect(output).toContain("Write more tests");
    expect(output).toContain("Track token usage");
  });

  it("includes item status in each row", () => {
    const output = generateRoadmapCsv(SAMPLE_ROADMAP);
    expect(output).toContain("Backlog");
    expect(output).toContain("In Progress");
    expect(output).toContain("Done");
  });

  it("includes linkedIssueNumber when present", () => {
    const output = generateRoadmapCsv(SAMPLE_ROADMAP);
    expect(output).toContain("4"); // Track token usage (#4)
    expect(output).toContain("8"); // Write more tests (#8)
  });

  it("applies filterStatus to limit output rows", () => {
    const output = generateRoadmapCsv(SAMPLE_ROADMAP, "Done");
    const lines = output.trimEnd().split("\n");
    expect(lines).toHaveLength(2); // header + 1 Done item
    expect(output).toContain("Track token usage");
    expect(output).not.toContain("Write more tests");
  });

  it("quotes fields containing commas per RFC 4180", () => {
    const roadmap = `# Bloom Evolution Roadmap\n\n## Backlog\n- [ ] Fix bug, add test\n`;
    const output = generateRoadmapCsv(roadmap);
    expect(output).toContain('"Fix bug, add test"');
  });

  it("output always ends with a trailing newline", () => {
    expect(generateRoadmapCsv(EMPTY_ROADMAP)).toMatch(/\n$/);
    expect(generateRoadmapCsv(SAMPLE_ROADMAP)).toMatch(/\n$/);
  });

  it("ROADMAP_HELP_TEXT lists --format csv", () => {
    expect(ROADMAP_HELP_TEXT).toContain("--format csv");
  });
});

describe("parseFormatFlag --format csv", () => {
  it("returns 'csv' when --format csv is passed", () => {
    expect(parseFormatFlag(["--format", "csv"])).toBe("csv");
  });

  it("still returns 'md' when --format md is passed", () => {
    expect(parseFormatFlag(["--format", "md"])).toBe("md");
  });

  it("returns undefined for unknown format values", () => {
    expect(parseFormatFlag(["--format", "xml"])).toBeUndefined();
  });

  it("returns undefined when --format flag is absent", () => {
    expect(parseFormatFlag([])).toBeUndefined();
  });

  it("returns undefined when --format has no following argument", () => {
    expect(parseFormatFlag(["--format"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-module invariant: display preview ≤ storage limit
// ---------------------------------------------------------------------------

describe("ROADMAP_BODY_PREVIEW_MAX_CHARS vs ITEM_BODY_LIMIT invariant", () => {
  it("ROADMAP_BODY_PREVIEW_MAX_CHARS is strictly less than ITEM_BODY_LIMIT", () => {
    // A display preview can never exceed the stored content length.
    // ROADMAP_BODY_PREVIEW_MAX_CHARS (120) is the truncation cap applied when
    // rendering item bodies in CLI/Markdown output; ITEM_BODY_LIMIT (500) is
    // the maximum number of characters stored per item body in ROADMAP.md.
    // If ROADMAP_BODY_PREVIEW_MAX_CHARS were raised above ITEM_BODY_LIMIT the
    // display logic would attempt to show more characters than are stored,
    // silently breaking the preview contract. This assertion ensures any
    // refactor that changes either constant is caught before shipping.
    expect(ROADMAP_BODY_PREVIEW_MAX_CHARS).toBeLessThan(ITEM_BODY_LIMIT);
  });

  it("ROADMAP_BODY_PREVIEW_MAX_CHARS is strictly less than PLANNING_BODY_PREVIEW_CHARS (cross-module invariant)", () => {
    // Roadmap display (120 chars) intentionally shows a shorter body preview
    // than the planning context (200 chars). If either constant drifts to
    // violate this ordering — e.g., ROADMAP_BODY_PREVIEW_MAX_CHARS is raised
    // or PLANNING_BODY_PREVIEW_CHARS is lowered — this test catches it before
    // the divergence silently changes UI density or LLM context quality.
    expect(ROADMAP_BODY_PREVIEW_MAX_CHARS).toBeLessThan(PLANNING_BODY_PREVIEW_CHARS);
  });
});
