import { describe, it, expect, vi } from "vitest";
import { generateRoadmapOutput, generateRoadmapJson, ROADMAP_BODY_PREVIEW_MAX_CHARS } from "../src/roadmap.js";
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
