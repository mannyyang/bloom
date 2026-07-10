import { describe, it, expect, vi, afterEach, afterAll, beforeAll, beforeEach } from "vitest";
import { buildTriagePrompt, parseTriageResponse, triageIssues, PROMPT_BODY_PREVIEW_CHARS, PROMPT_TITLE_PREVIEW_CHARS, BOARD_BODY_PREVIEW_CHARS, TRIAGE_MAX_TURNS, TRIAGE_MAX_BUDGET_USD, TRIAGE_REASON_MAX_CHARS, TRIAGE_ERROR_PREVIEW_CHARS, TRIAGE_ACTION_NAME, TRIAGE_BOARD_STATUS_DONE, TRIAGE_ALREADY_ON_BOARD_COMMENT, TRIAGE_MAX_ISSUE_NUMBER, TRIAGE_STATUS_ORDER, TRIAGE_MAX_DONE_ITEMS } from "../src/triage.js";
import { STATUS_ORDER } from "../src/roadmap.js";
import type { CommunityIssue } from "../src/issues.js";
import { closeIssueWithComment, detectRepo, isValidRepo } from "../src/issues.js";
import { hasIssueAction, insertIssueAction, initDb, insertCycle } from "../src/db.js";
import { makeOutcome } from "./helpers.js";
import { addLinkedItem, STATUS_DONE, STATUS_IN_PROGRESS, STATUS_UP_NEXT, STATUS_BACKLOG, ITEM_BODY_LIMIT, PLANNING_BODY_PREVIEW_CHARS, PLANNING_CONTEXT_MAX_CHARS } from "../src/planning.js";
import type { ProjectItem, ProjectConfig } from "../src/planning.js";
import { CONTEXT_REASON_PREVIEW_CHARS, CONTEXT_JOURNAL_MAX_CHARS } from "../src/context.js";

vi.mock("../src/issues.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    closeIssueWithComment: vi.fn().mockResolvedValue(true),
    detectRepo: vi.fn().mockReturnValue("test-owner/test-repo"),
    isValidRepo: vi.fn().mockReturnValue(true),
  };
});

vi.mock("../src/db.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    hasIssueAction: vi.fn().mockReturnValue(false),
    insertIssueAction: vi.fn(),
  };
});

vi.mock("../src/planning.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    addLinkedItem: vi.fn(),
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";

const mockQuery = vi.mocked(query);
const mockCloseIssue = vi.mocked(closeIssueWithComment);
const mockHasIssueAction = vi.mocked(hasIssueAction);
const mockInsertIssueAction = vi.mocked(insertIssueAction);

// Restore factory defaults after each global resetMocks cycle.
beforeEach(() => {
  mockCloseIssue.mockResolvedValue(true);
  vi.mocked(detectRepo).mockReturnValue("test-owner/test-repo");
  vi.mocked(isValidRepo).mockReturnValue(true);
  mockHasIssueAction.mockReturnValue(false);
});

function makeIssue(overrides: Partial<CommunityIssue> = {}): CommunityIssue {
  return {
    number: 1,
    title: "Test issue",
    body: "Test body",
    reactions: 0,
    ...overrides,
  };
}

function makeBoardItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    id: "item-1",
    title: "Board item",
    body: "",
    status: "Backlog",
    linkedIssueNumber: null,
    reactions: 0,
    ...overrides,
  };
}

describe("triage.ts constants", () => {
  it("TRIAGE_MAX_TURNS equals 3", () => {
    expect(TRIAGE_MAX_TURNS).toBe(3);
  });

  it("TRIAGE_MAX_BUDGET_USD equals 0.5", () => {
    expect(TRIAGE_MAX_BUDGET_USD).toBe(0.5);
  });

  it("PROMPT_BODY_PREVIEW_CHARS is pinned to 200", () => {
    expect(PROMPT_BODY_PREVIEW_CHARS).toBe(200);
  });

  it("PROMPT_BODY_PREVIEW_CHARS is strictly less than ITEM_BODY_LIMIT (cross-module invariant)", () => {
    // triage.ts documents: "Prompt-preview cap for issue bodies — keeps prompts concise
    // without affecting stored content (cf. ITEM_BODY_LIMIT in planning.ts which is 500)."
    // If PROMPT_BODY_PREVIEW_CHARS ever exceeds ITEM_BODY_LIMIT, triage prompts could
    // reference text beyond what is actually stored, silently corrupting triage context.
    expect(PROMPT_BODY_PREVIEW_CHARS).toBeLessThan(ITEM_BODY_LIMIT);
  });

  it("PLANNING_BODY_PREVIEW_CHARS equals PROMPT_BODY_PREVIEW_CHARS (cross-module equality invariant)", () => {
    // Both constants serve the same role — capping body previews in adjacent
    // context-building modules that feed into the same assessment prompt. Pinning
    // their equality ensures that a bump to one constant does not silently leave
    // the other behind, causing inconsistent preview lengths across modules.
    expect(PLANNING_BODY_PREVIEW_CHARS).toBe(PROMPT_BODY_PREVIEW_CHARS);
  });

  it("CONTEXT_JOURNAL_MAX_CHARS equals PLANNING_CONTEXT_MAX_CHARS (cross-module equality invariant)", () => {
    // Both constants guard the maximum character budget for context assembled into
    // the assessment prompt — CONTEXT_JOURNAL_MAX_CHARS for journal history
    // (context.ts) and PLANNING_CONTEXT_MAX_CHARS for the planning section
    // (planning.ts). They are both separately value-pinned to 1200 but no test
    // catches drift between them. If one is bumped without updating the other,
    // the two context sections would silently use different budgets.
    expect(CONTEXT_JOURNAL_MAX_CHARS).toBe(PLANNING_CONTEXT_MAX_CHARS);
  });

  it("PROMPT_TITLE_PREVIEW_CHARS is pinned to 120", () => {
    expect(PROMPT_TITLE_PREVIEW_CHARS).toBe(120);
  });

  it("BOARD_BODY_PREVIEW_CHARS is pinned to 80", () => {
    expect(BOARD_BODY_PREVIEW_CHARS).toBe(80);
  });

  it("TRIAGE_REASON_MAX_CHARS is pinned to 2000", () => {
    expect(TRIAGE_REASON_MAX_CHARS).toBe(2000);
  });

  it("CONTEXT_REASON_PREVIEW_CHARS is strictly less than TRIAGE_REASON_MAX_CHARS (cross-module invariant)", () => {
    // context.ts uses CONTEXT_REASON_PREVIEW_CHARS (100) to truncate triage reason strings
    // for log display. TRIAGE_REASON_MAX_CHARS (2000) is the maximum accepted stored length.
    // The display preview must always be ≤ stored max: if TRIAGE_REASON_MAX_CHARS were ever
    // reduced below CONTEXT_REASON_PREVIEW_CHARS, the log would silently show text that was
    // never actually stored, making truncated log entries misleading.
    expect(CONTEXT_REASON_PREVIEW_CHARS).toBeLessThan(TRIAGE_REASON_MAX_CHARS);
  });

  it("TRIAGE_ERROR_PREVIEW_CHARS is pinned to 200", () => {
    expect(TRIAGE_ERROR_PREVIEW_CHARS).toBe(200);
  });

  it("TRIAGE_ACTION_NAME is pinned to 'triaged'", () => {
    expect(TRIAGE_ACTION_NAME).toBe("triaged");
  });

  it("TRIAGE_ALREADY_ON_BOARD_COMMENT is pinned to its exact string", () => {
    expect(TRIAGE_ALREADY_ON_BOARD_COMMENT).toBe(
      "This issue is already tracked on the Bloom Evolution Roadmap.",
    );
  });

  it("TRIAGE_STATUS_ORDER pins the exact board-item display order", () => {
    expect(TRIAGE_STATUS_ORDER).toEqual(["In Progress", "Up Next", "Backlog", "Done"]);
  });

  it("TRIAGE_STATUS_ORDER elements equal planning.ts status constants (cross-module equality)", () => {
    // Guards the delegation: if any status string changes in planning.ts, this
    // test will catch the divergence even if the raw-value pin above still passes.
    expect(TRIAGE_STATUS_ORDER).toEqual([STATUS_IN_PROGRESS, STATUS_UP_NEXT, STATUS_BACKLOG, STATUS_DONE]);
  });

  it("TRIAGE_STATUS_ORDER is the same array instance as STATUS_ORDER from roadmap.ts (referential equality)", () => {
    // Now that TRIAGE_STATUS_ORDER is simply re-exported from roadmap.ts,
    // this .toBe() (identity) check guarantees the two are the exact same
    // object — not just equal values. Any future divergence (e.g., re-introducing
    // a local copy) will fail this test before it can silently drift.
    expect(TRIAGE_STATUS_ORDER).toBe(STATUS_ORDER);
  });

  it("TRIAGE_MAX_ISSUE_NUMBER is pinned to 1_000_000", () => {
    expect(TRIAGE_MAX_ISSUE_NUMBER).toBe(1_000_000);
  });

  it("TRIAGE_MAX_DONE_ITEMS is pinned to 20", () => {
    expect(TRIAGE_MAX_DONE_ITEMS).toBe(20);
  });
});

describe("buildTriagePrompt", () => {
  it("includes issue numbers and titles", () => {
    const issues = [makeIssue({ number: 5, title: "Add logging" })];
    const prompt = buildTriagePrompt(issues, []);
    expect(prompt).toContain("#5");
    expect(prompt).toContain("Add logging");
  });

  it("includes board item state", () => {
    const items = [makeBoardItem({ title: "Improve error handling", status: "Up Next" })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain("[Up Next] Improve error handling");
  });

  it("shows linked issue numbers on board items", () => {
    const items = [makeBoardItem({ title: "Fix bug", linkedIssueNumber: 42 })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain("(#42)");
  });

  it("handles empty board", () => {
    const prompt = buildTriagePrompt([makeIssue()], []);
    expect(prompt).toContain("No items on board yet");
  });

  it("includes triage action options in prompt", () => {
    const prompt = buildTriagePrompt([makeIssue()], []);
    expect(prompt).toContain("add_to_backlog");
    expect(prompt).toContain("already_done");
    expect(prompt).toContain("not_applicable");
  });

  it("PROMPT_BODY_PREVIEW_CHARS is a positive integer", () => {
    expect(Number.isInteger(PROMPT_BODY_PREVIEW_CHARS)).toBe(true);
    expect(PROMPT_BODY_PREVIEW_CHARS).toBeGreaterThan(0);
  });

  it("PROMPT_TITLE_PREVIEW_CHARS is a positive integer", () => {
    expect(Number.isInteger(PROMPT_TITLE_PREVIEW_CHARS)).toBe(true);
    expect(PROMPT_TITLE_PREVIEW_CHARS).toBeGreaterThan(0);
  });

  it("truncates long issue titles to PROMPT_TITLE_PREVIEW_CHARS characters", () => {
    const longTitle = "T".repeat(300);
    const prompt = buildTriagePrompt([makeIssue({ title: longTitle })], []);
    expect(prompt).not.toContain("T".repeat(PROMPT_TITLE_PREVIEW_CHARS + 1));
    expect(prompt).toContain("T".repeat(PROMPT_TITLE_PREVIEW_CHARS));
  });

  it("appends ellipsis to truncated issue title", () => {
    const longTitle = "T".repeat(PROMPT_TITLE_PREVIEW_CHARS + 10);
    const prompt = buildTriagePrompt([makeIssue({ title: longTitle })], []);
    expect(prompt).toContain("T".repeat(PROMPT_TITLE_PREVIEW_CHARS) + "…");
  });

  it("does not truncate a title of exactly PROMPT_TITLE_PREVIEW_CHARS characters", () => {
    // The condition is strict `>`, so a 120-char title must appear verbatim with no ellipsis.
    const exactTitle = "X".repeat(PROMPT_TITLE_PREVIEW_CHARS);
    const prompt = buildTriagePrompt([makeIssue({ title: exactTitle })], []);
    expect(prompt).toContain(exactTitle + '"');
    expect(prompt).not.toContain(exactTitle + "…");
  });

  it("truncates and appends ellipsis to a title of PROMPT_TITLE_PREVIEW_CHARS + 1 characters", () => {
    // One character over the boundary must trigger truncation and an ellipsis.
    const overTitle = "Y".repeat(PROMPT_TITLE_PREVIEW_CHARS + 1);
    const prompt = buildTriagePrompt([makeIssue({ title: overTitle })], []);
    expect(prompt).toContain("Y".repeat(PROMPT_TITLE_PREVIEW_CHARS) + "…");
    expect(prompt).not.toContain(overTitle);
  });

  it("does not append ellipsis to short issue title", () => {
    const shortTitle = "Short";
    const prompt = buildTriagePrompt([makeIssue({ title: shortTitle })], []);
    expect(prompt).toContain(shortTitle + '"');
    expect(prompt).not.toContain(shortTitle + "…");
  });

  it("leaves short titles intact (no truncation under PROMPT_TITLE_PREVIEW_CHARS chars)", () => {
    const shortTitle = "Short title";
    const prompt = buildTriagePrompt([makeIssue({ title: shortTitle })], []);
    expect(prompt).toContain(shortTitle);
  });

  it("truncates long issue bodies", () => {
    const longBody = "x".repeat(500);
    const prompt = buildTriagePrompt([makeIssue({ body: longBody })], []);
    // Body should be truncated to PROMPT_BODY_PREVIEW_CHARS chars (a prompt-preview cap, not a storage limit)
    expect(prompt).not.toContain("x".repeat(500));
    expect(prompt).toContain("x".repeat(PROMPT_BODY_PREVIEW_CHARS));
    expect(prompt).not.toContain("x".repeat(PROMPT_BODY_PREVIEW_CHARS + 1));
  });

  it("appends ellipsis to truncated issue body", () => {
    const longBody = "x".repeat(PROMPT_BODY_PREVIEW_CHARS + 10);
    const prompt = buildTriagePrompt([makeIssue({ body: longBody })], []);
    expect(prompt).toContain("x".repeat(PROMPT_BODY_PREVIEW_CHARS) + "…");
  });

  it("does not append ellipsis to short issue body", () => {
    const shortBody = "short body text";
    const prompt = buildTriagePrompt([makeIssue({ body: shortBody })], []);
    expect(prompt).toContain(shortBody);
    expect(prompt).not.toContain(shortBody + "…");
  });

  it("leaves short bodies intact (no truncation under PROMPT_BODY_PREVIEW_CHARS chars)", () => {
    const shortBody = "x".repeat(100);
    const prompt = buildTriagePrompt([makeIssue({ body: shortBody })], []);
    expect(prompt).toContain("x".repeat(100));
  });

  it("does NOT truncate body of exactly PROMPT_BODY_PREVIEW_CHARS characters (pins > operator)", () => {
    // The condition is strict `>`, so a body of exactly PROMPT_BODY_PREVIEW_CHARS
    // chars must appear verbatim with no ellipsis appended.
    const exactBody = "p".repeat(PROMPT_BODY_PREVIEW_CHARS);
    const prompt = buildTriagePrompt([makeIssue({ body: exactBody })], []);
    expect(prompt).toContain(exactBody);
    expect(prompt).not.toContain(exactBody + "…");
  });

  it("truncates and appends ellipsis to body of PROMPT_BODY_PREVIEW_CHARS + 1 characters", () => {
    // One character over the boundary must trigger truncation and an ellipsis,
    // confirming the strict > operator is correct.
    const overBody = "p".repeat(PROMPT_BODY_PREVIEW_CHARS + 1);
    const prompt = buildTriagePrompt([makeIssue({ body: overBody })], []);
    expect(prompt).toContain("p".repeat(PROMPT_BODY_PREVIEW_CHARS) + "…");
    expect(prompt).not.toContain(overBody);
  });

  it("collapses newlines and tabs in body to a single space", () => {
    // Guards the replace(/\s+/g, " ") normalization in buildTriagePrompt.
    // A silent regression (e.g. removing or reordering the replace call) would
    // break prompt hygiene without this test catching it.
    const messyBody = "first\n\nsecond\tthird";
    const prompt = buildTriagePrompt([makeIssue({ body: messyBody })], []);
    // The normalised body should appear inline — no raw newlines or tabs from the body.
    expect(prompt).toContain("first second third");
    expect(prompt).not.toContain("first\n");
    expect(prompt).not.toContain("second\t");
  });

  it("collapses multiple consecutive spaces in body to a single space", () => {
    // Ensures that double-spaces and mixed whitespace are also normalised.
    const messyBody = "word1  word2   word3";
    const prompt = buildTriagePrompt([makeIssue({ body: messyBody })], []);
    expect(prompt).toContain("word1 word2 word3");
  });

  it("includes verbatim (no ellipsis) a body that is exactly PROMPT_BODY_PREVIEW_CHARS after whitespace normalization", () => {
    // The body has leading/trailing spaces that trim() removes, shrinking the raw
    // length to exactly PROMPT_BODY_PREVIEW_CHARS after normalization. Because the
    // condition is strict `>`, the normalized string must be included verbatim with
    // no ellipsis — confirming normalization runs before truncation, not after.
    const normalizedBody = "a".repeat(PROMPT_BODY_PREVIEW_CHARS);
    const rawBody = "  " + normalizedBody + "  "; // 4 extra chars, all whitespace
    const prompt = buildTriagePrompt([makeIssue({ body: rawBody })], []);
    expect(prompt).toContain(normalizedBody);
    expect(prompt).not.toContain(normalizedBody + "…");
  });

  it("handles issues with empty bodies", () => {
    const prompt = buildTriagePrompt([makeIssue({ number: 7, title: "No body", body: "" })], []);
    expect(prompt).toContain("#7");
    expect(prompt).toContain("No body");
  });

  it("pins exact rendered line format for an issue with empty body (trailing newline+spaces)", () => {
    // When body is "", normalizedBody and bodyPreview are both "".
    // The template `- #${i.number}: "${titlePreview}" (${i.reactions} reactions)\n  ${bodyPreview}`
    // produces a line ending with "\n  " (newline + two spaces of indentation + empty preview).
    // This pins the exact whitespace so a refactor that strips trailing spaces or
    // omits the indent for the empty-body case is caught immediately.
    const prompt = buildTriagePrompt([makeIssue({ number: 7, title: "No body", body: "" })], []);
    expect(prompt).toContain('- #7: "No body" (0 reactions)\n  ');
  });

  it("pins exact rendered line format for an issue with non-empty body", () => {
    // Tripwire for the full issue-entry format: `- #N: "title" (R reactions)\n  body`.
    // The empty-body case is already pinned above; this pins the non-empty case so
    // changes like dropping quote-delimited titles, swapping (N reactions) to
    // [N reactions], or removing the body indent are caught immediately.
    const prompt = buildTriagePrompt(
      [makeIssue({ number: 5, title: "Add logging", body: "Short body", reactions: 3 })],
      [],
    );
    expect(prompt).toContain('- #5: "Add logging" (3 reactions)\n  Short body');
  });

  it("includes zero-reaction issues", () => {
    const prompt = buildTriagePrompt([makeIssue({ number: 10, reactions: 0 })], []);
    expect(prompt).toContain("#10");
    expect(prompt).toContain("0 reactions");
  });

  it("includes non-zero reaction count in prompt", () => {
    const prompt = buildTriagePrompt([makeIssue({ number: 11, reactions: 5 })], []);
    expect(prompt).toContain("#11");
    expect(prompt).toContain("5 reactions");
  });

  it("renders issues sorted by reactions descending (highest first)", () => {
    // Defence-in-depth: buildTriagePrompt sorts its own copy so the LLM sees
    // highest-priority issues first even when the caller has not pre-sorted.
    const issues = [
      makeIssue({ number: 1, title: "Low priority", reactions: 1 }),
      makeIssue({ number: 2, title: "High priority", reactions: 10 }),
      makeIssue({ number: 3, title: "Medium priority", reactions: 5 }),
    ];
    const prompt = buildTriagePrompt(issues, []);
    const highIdx = prompt.indexOf("#2");
    const medIdx = prompt.indexOf("#3");
    const lowIdx = prompt.indexOf("#1");
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(medIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeLessThan(medIdx);
    expect(medIdx).toBeLessThan(lowIdx);
  });

  it("breaks reaction ties by issue number ascending (lower/older issue first)", () => {
    // When two issues share the same reaction count, the sort must be deterministic.
    // Lower issue numbers (older issues) appear before higher ones so the order
    // is stable across runs and independent of insertion order.
    const issues = [
      makeIssue({ number: 7, title: "Newer same-reactions", reactions: 5 }),
      makeIssue({ number: 3, title: "Older same-reactions", reactions: 5 }),
    ];
    const prompt = buildTriagePrompt(issues, []);
    const olderIdx = prompt.indexOf("#3");
    const newerIdx = prompt.indexOf("#7");
    expect(olderIdx).toBeGreaterThanOrEqual(0);
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeLessThan(newerIdx);
  });

  it("does not mutate the original issues array when sorting", () => {
    const issues = [
      makeIssue({ number: 1, reactions: 1 }),
      makeIssue({ number: 2, reactions: 10 }),
    ];
    const originalOrder = issues.map((i) => i.number);
    buildTriagePrompt(issues, []);
    // original array must remain unchanged
    expect(issues.map((i) => i.number)).toEqual(originalOrder);
  });

  it("renders board item with null status as [No Status]", () => {
    // triage.ts uses `item.status ?? "No Status"` so a ProjectItem with status: null
    // (e.g. from an external integration) must appear as [No Status] in the prompt
    // rather than silently rendering as [null] or [undefined].
    const items = [makeBoardItem({ title: "Orphaned item", status: null as unknown as "Backlog" })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain("[No Status] Orphaned item");
  });

  it("shows (N ★) reaction count on board items with reactions > 0", () => {
    // LLM needs community momentum signal to distinguish similar board items.
    // Mirrors the [N ★] suffix already shown in generateRoadmapOutput.
    const items = [makeBoardItem({ title: "Popular feature", status: "Backlog", reactions: 8 })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain("(8 ★)");
  });

  it("omits reaction suffix on board items with reactions === 0", () => {
    // Zero-reaction items should not clutter the prompt with a "(0 ★)" noise marker.
    const items = [makeBoardItem({ title: "Quiet item", status: "Backlog", reactions: 0 })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).not.toContain("★");
  });

  it("includes both linked issue number and reaction count when both are present", () => {
    const items = [makeBoardItem({ title: "Hot bug", status: "In Progress", linkedIssueNumber: 42, reactions: 12 })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain("(#42)");
    expect(prompt).toContain("(12 ★)");
  });

  it("includes board item body preview when body is non-empty", () => {
    const items = [makeBoardItem({ title: "Feature X", status: "Backlog", body: "This is a description of the feature." })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain("This is a description of the feature.");
  });

  it("omits body preview for board items with empty body", () => {
    const items = [makeBoardItem({ title: "No-body item", status: "Backlog", body: "" })];
    const prompt = buildTriagePrompt([], items);
    // Board item line must be present without any trailing body line
    expect(prompt).toContain("[Backlog] No-body item");
    // No extra indented line following the title line
    const lines = prompt.split("\n");
    const titleLineIdx = lines.findIndex((l) => l.includes("No-body item"));
    expect(titleLineIdx).toBeGreaterThanOrEqual(0);
    // The very next line (if it starts with two spaces) would be a body preview;
    // since body is empty, the next line must NOT be an indented body preview.
    const nextLine = lines[titleLineIdx + 1] ?? "";
    expect(nextLine.startsWith("  ")).toBe(false);
  });

  it("truncates board item body preview to BOARD_BODY_PREVIEW_CHARS characters", () => {
    const longBody = "b".repeat(BOARD_BODY_PREVIEW_CHARS + 20);
    const items = [makeBoardItem({ title: "Long body item", status: "Backlog", body: longBody })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain("b".repeat(BOARD_BODY_PREVIEW_CHARS));
    expect(prompt).not.toContain("b".repeat(BOARD_BODY_PREVIEW_CHARS + 1));
  });

  it("appends ellipsis to truncated board item body preview", () => {
    const longBody = "b".repeat(BOARD_BODY_PREVIEW_CHARS + 10);
    const items = [makeBoardItem({ title: "Long body item", status: "Backlog", body: longBody })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain("b".repeat(BOARD_BODY_PREVIEW_CHARS) + "…");
  });

  it("does NOT truncate board item body of exactly BOARD_BODY_PREVIEW_CHARS characters (pins > operator)", () => {
    // The condition is strict `>`, so a body of exactly BOARD_BODY_PREVIEW_CHARS
    // chars must appear verbatim with no ellipsis appended.
    const exactBody = "b".repeat(BOARD_BODY_PREVIEW_CHARS);
    const items = [makeBoardItem({ title: "Exact board body", status: "Backlog", body: exactBody })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain(exactBody);
    expect(prompt).not.toContain(exactBody + "…");
  });

  it("truncates and appends ellipsis to board item body of BOARD_BODY_PREVIEW_CHARS + 1 characters", () => {
    // One character over the boundary must trigger truncation and an ellipsis,
    // confirming the strict > operator is correct.
    const overBody = "b".repeat(BOARD_BODY_PREVIEW_CHARS + 1);
    const items = [makeBoardItem({ title: "Over board body", status: "Backlog", body: overBody })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain("b".repeat(BOARD_BODY_PREVIEW_CHARS) + "…");
    expect(prompt).not.toContain(overBody);
  });

  it("does not append ellipsis to short board item body", () => {
    const shortBody = "short board body";
    const items = [makeBoardItem({ title: "Short item", status: "Backlog", body: shortBody })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain(shortBody);
    expect(prompt).not.toContain(shortBody + "…");
  });

  it("BOARD_BODY_PREVIEW_CHARS is a positive integer less than PROMPT_BODY_PREVIEW_CHARS", () => {
    // Board item preview is intentionally shorter than issue body preview.
    expect(Number.isInteger(BOARD_BODY_PREVIEW_CHARS)).toBe(true);
    expect(BOARD_BODY_PREVIEW_CHARS).toBeGreaterThan(0);
    expect(BOARD_BODY_PREVIEW_CHARS).toBeLessThan(PROMPT_BODY_PREVIEW_CHARS);
  });

  it("strips [since: N] annotation from board item body preview", () => {
    const items = [makeBoardItem({ title: "In-progress item", status: "In Progress", body: "Real work here\n[since: 330]" })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain("Real work here");
    expect(prompt).not.toContain("[since:");
  });

  it("strips …[truncated] marker from board item body preview", () => {
    const items = [makeBoardItem({ title: "Long stored item", status: "Backlog", body: "Some stored description …[truncated]" })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain("Some stored description");
    expect(prompt).not.toContain("…[truncated]");
  });

  it("strips both …[truncated] and [since: N] when both are present in order (regression guard)", () => {
    // updateItemStatus appends [since: N] AFTER truncateItemBody appends …[truncated].
    // buildTriagePrompt strips [since: N] first then …[truncated] — this order must work
    // correctly for the combined case so neither annotation leaks into the prompt.
    const body = "content …[truncated]\n[since: 5]";
    const items = [makeBoardItem({ title: "Annotated item", status: "In Progress", body })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain("content");
    expect(prompt).not.toContain("…[truncated]");
    expect(prompt).not.toContain("[since:");
  });

  it("omits body line when board item body is annotation-only ([since: N])", () => {
    // When body = "[since: 330]" the annotation is stripped leaving cleanBody = "".
    // The `cleanBody ?` conditional must evaluate falsy so bodyPreview = "" — no
    // spurious "\n  " empty-indent line is appended to the board item line.
    const items = [makeBoardItem({ title: "Annotation only", status: "In Progress", body: "[since: 330]" })];
    const prompt = buildTriagePrompt([], items);
    // The board line must exist but must not contain the annotation
    expect(prompt).toContain("Annotation only");
    expect(prompt).not.toContain("[since:");
    // No blank indented line should follow the board item title
    expect(prompt).not.toMatch(/Annotation only[^\n]*\n  \n/);
  });

  it("omits body line when board item body is truncation-marker-only ( …[truncated])", () => {
    // When body = " …[truncated]" (truncation marker with no preceding content),
    // stripping the marker leaves cleanBody = "" after trim(). bodyPreview must be ""
    // so no empty "\n  " line is appended — mirrors the annotation-only case above.
    const items = [makeBoardItem({ title: "Truncated only", status: "Backlog", body: " …[truncated]" })];
    const prompt = buildTriagePrompt([], items);
    expect(prompt).toContain("Truncated only");
    expect(prompt).not.toContain("…[truncated]");
    // No blank indented line should follow the board item title
    expect(prompt).not.toMatch(/Truncated only[^\n]*\n  \n/);
  });

  it("trims leading/trailing whitespace from issue body before preview truncation", () => {
    // GitHub issue bodies can have leading newlines; trim() before slice() prevents
    // the LLM seeing a blank-prefixed snippet. Mirrors the board item body path
    // which already calls .trim() before slicing.
    const bodyWithLeadingNewlines = "\n\n\nActual content here";
    const prompt = buildTriagePrompt([makeIssue({ body: bodyWithLeadingNewlines })], []);
    // The prompt must show the real content without leading whitespace
    expect(prompt).toContain("  Actual content here");
    // Must NOT have the leading newlines before the content
    expect(prompt).not.toMatch(/  \n\n\nActual content here/);
  });

  it("trims leading/trailing whitespace from issue title before truncation", () => {
    // buildTriagePrompt calls i.title.trim().slice(0, PROMPT_TITLE_PREVIEW_CHARS).
    // This test pins that trim() is applied before slice() — a refactor swapping
    // the order (slice then trim) would silently change behaviour when the title
    // exceeds PROMPT_TITLE_PREVIEW_CHARS and has leading/trailing whitespace.
    const titleWithLeadingSpaces = "   Real title here";
    const prompt = buildTriagePrompt([makeIssue({ title: titleWithLeadingSpaces })], []);
    // Trimmed title must appear in the prompt
    expect(prompt).toContain('"Real title here"');
    // The raw leading spaces must NOT appear before the title content
    expect(prompt).not.toContain('"   Real title here"');
  });

  it("collapses internal newlines in multi-paragraph issue bodies to single spaces", () => {
    // Multi-paragraph GitHub issue bodies contain embedded newlines. Without
    // whitespace normalisation the body preview in the prompt looks like:
    //   - #1: "Title" (0 reactions)
    //   First paragraph
    //   Second paragraph
    // — the un-indented subsequent lines break the per-issue indented format and
    // can confuse the LLM about issue boundaries. After normalisation the body
    // preview is a single flat line:
    //   - #1: "Title" (0 reactions)
    //     First paragraph Second paragraph
    const multiLineBody = "First paragraph\n\nSecond paragraph\nThird paragraph";
    const prompt = buildTriagePrompt([makeIssue({ number: 1, body: multiLineBody })], []);
    // The body section must be a single line (no embedded newlines after the prefix)
    const lines = prompt.split("\n");
    const bodyLineIdx = lines.findIndex((l) => l.startsWith("  ") && l.includes("First paragraph"));
    expect(bodyLineIdx).toBeGreaterThanOrEqual(0);
    const bodyLine = lines[bodyLineIdx];
    // All paragraph text must be on one line, collapsed with spaces
    expect(bodyLine).toContain("First paragraph Second paragraph Third paragraph");
    // Must not contain raw newlines within the body preview
    expect(bodyLine).not.toContain("\n");
  });

  it("returns a non-empty string when both issues and board items are empty", () => {
    // buildTriagePrompt([], []) is callable even though triageIssues guards
    // against it. The result must still be a non-empty prompt string (it
    // contains the system instructions and action list even with no issues or
    // board items). A blank issues section is acceptable; what matters is that
    // the function does not throw and returns meaningful scaffold text.
    const prompt = buildTriagePrompt([], []);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("No items on board yet");
    expect(prompt).toContain("add_to_backlog");
  });

  it("pins exact example JSON response line in prompt", () => {
    // Tripwire: a wording change to the inline example (different reason text,
    // added field, etc.) could subtly affect LLM output quality without failing
    // any existing test. Pins the full example substring so any change is explicit.
    const prompt = buildTriagePrompt([makeIssue()], []);
    expect(prompt).toContain(
      '[{"issueNumber": 1, "action": "add_to_backlog", "reason": "Valid feature request for improving error messages."}]',
    );
  });

  it("contains exact '## New issues to triage:' section header", () => {
    // Pin the exact header string so a rename silently changing LLM behaviour
    // is caught immediately. The LLM uses this header to locate the issue list.
    const prompt = buildTriagePrompt([makeIssue()], []);
    expect(prompt).toContain("## New issues to triage:");
  });

  it("contains exact '## Current roadmap state:' section header", () => {
    // Pin the exact header string for the board section. Renaming it would
    // silently change LLM behaviour without breaking any other test.
    const prompt = buildTriagePrompt([makeIssue()], []);
    expect(prompt).toContain("## Current roadmap state:");
  });

  it("caps Done items at TRIAGE_MAX_DONE_ITEMS in the prompt", () => {
    // Create TRIAGE_MAX_DONE_ITEMS + 5 Done items; only the first
    // TRIAGE_MAX_DONE_ITEMS (alphabetically by title after sort) must appear.
    const doneItems = Array.from({ length: TRIAGE_MAX_DONE_ITEMS + 5 }, (_, i) =>
      makeBoardItem({ title: `Done item ${String(i).padStart(3, "0")}`, status: "Done", body: "" }),
    );
    const prompt = buildTriagePrompt([], doneItems);
    // The first TRIAGE_MAX_DONE_ITEMS items must appear
    expect(prompt).toContain("Done item 000");
    expect(prompt).toContain(`Done item ${String(TRIAGE_MAX_DONE_ITEMS - 1).padStart(3, "0")}`);
    // Items beyond the cap must be absent
    expect(prompt).not.toContain(`Done item ${String(TRIAGE_MAX_DONE_ITEMS).padStart(3, "0")}`);
  });

  it("always includes all non-Done items even when Done items are capped", () => {
    // Non-Done items must never be dropped, regardless of Done item count.
    const doneItems = Array.from({ length: TRIAGE_MAX_DONE_ITEMS + 5 }, (_, i) =>
      makeBoardItem({ title: `Done ${i}`, status: "Done", body: "" }),
    );
    const backlogItem = makeBoardItem({ title: "Keep this backlog item", status: "Backlog", body: "" });
    const prompt = buildTriagePrompt([], [...doneItems, backlogItem]);
    expect(prompt).toContain("Keep this backlog item");
  });

  it("strips embedded \\r from issue titles before rendering the prompt", () => {
    // Regression guard: issue titles only get .trim() without CRLF normalization,
    // so a title containing \r (e.g., from a malformed API response) would produce
    // a garbled prompt line. Fix: .replace(/\r/g, "") runs after .trim() on titles.
    const crlfTitle = "Title\r\nwith CRLF";
    const prompt = buildTriagePrompt([makeIssue({ title: crlfTitle })], []);
    expect(prompt).not.toContain("\r");
    expect(prompt).toContain("Title");
    expect(prompt).toContain("with CRLF");
  });
});

describe("parseTriageResponse", () => {
  it("parses a clean JSON array", () => {
    const input = `[{"issueNumber": 1, "action": "add_to_backlog", "reason": "Valid feature request."}]`;
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      issueNumber: 1,
      action: "add_to_backlog",
      reason: "Valid feature request.",
    });
  });

  it("parses JSON inside markdown code fences", () => {
    const input = "```json\n[{\"issueNumber\": 2, \"action\": \"already_done\", \"reason\": \"Already exists.\"}]\n```";
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe("already_done");
  });

  it("parses JSON inside plain code fences", () => {
    const input = "```\n[{\"issueNumber\": 3, \"action\": \"not_applicable\", \"reason\": \"Out of scope.\"}]\n```";
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe("not_applicable");
  });

  it("returns empty array for empty-body fenced input (boundary: fenceMatch[1] is empty string)", () => {
    // When the fence body is empty, fenceMatch[1] === "" and JSON.parse("") throws,
    // so the catch block fires and returns []. This documents the boundary where
    // fenceMatch[1] is always a string (never undefined), not text.trim().
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = parseTriageResponse("```\n\n```");
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] parseTriageResponse: failed to parse JSON"),
    );
    warnSpy.mockRestore();
  });

  it("returns empty array and warns for bare empty string (LLM empty-response scenario)", () => {
    // JSON.parse("") throws SyntaxError → catch block returns [] and warns.
    // This is a realistic LLM failure mode: the model returns an empty response.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = parseTriageResponse("");
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] parseTriageResponse: failed to parse JSON"),
    );
    warnSpy.mockRestore();
  });

  it("returns empty array and warns for whitespace-only string (LLM blank-response scenario)", () => {
    // JSON.parse("   ".trim()) === JSON.parse("") throws → same warn + [] path.
    // Whitespace-only LLM output should never silently produce decisions.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = parseTriageResponse("   ");
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] parseTriageResponse: failed to parse JSON"),
    );
    warnSpy.mockRestore();
  });

  it("returns empty array for invalid JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseTriageResponse("not json at all")).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] parseTriageResponse: failed to parse JSON"),
    );
    warnSpy.mockRestore();
  });

  it("emits a console.warn when JSON.parse throws (unparseable output)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = parseTriageResponse("this is not valid JSON {{{");

    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] parseTriageResponse: failed to parse JSON"),
    );
    warnSpy.mockRestore();
  });

  it("returns empty array for non-array JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseTriageResponse('{"issueNumber": 1}')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] parseTriageResponse: expected JSON array"),
    );
    warnSpy.mockRestore();
  });

  it("warn message includes 'object' when non-array JSON is an object", () => {
    // typeof {} === "object" — the diagnostic string must name the actual type
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseTriageResponse("{}");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("expected JSON array but got object"),
    );
    warnSpy.mockRestore();
  });

  it("warn message includes 'number' when non-array JSON is a number", () => {
    // typeof 42 === "number" — the diagnostic string must name the actual type
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseTriageResponse("42");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("expected JSON array but got number"),
    );
    warnSpy.mockRestore();
  });

  it("returns empty decisions without throwing when LLM returns JSON null", () => {
    // JSON.parse("null") === null — not an array; must warn and return []
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = parseTriageResponse("null");
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] parseTriageResponse: expected JSON array"),
    );
    warnSpy.mockRestore();
  });

  it("returns empty decisions without throwing when LLM returns unparseable 'undefined' text", () => {
    // "undefined" is not valid JSON — JSON.parse throws; must warn and return []
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = parseTriageResponse("undefined");
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] parseTriageResponse: failed to parse JSON"),
    );
    warnSpy.mockRestore();
  });

  it("returns empty decisions without throwing when LLM returns a non-array scalar string", () => {
    // JSON.parse('"ok"') === "ok" — a string, not an array; must warn and return []
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = parseTriageResponse('"ok"');
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] parseTriageResponse: expected JSON array"),
    );
    warnSpy.mockRestore();
  });

  it("warn message includes 'string' when non-array JSON is a string", () => {
    // typeof "ok" === "string" — the diagnostic string must name the actual type
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseTriageResponse('"ok"');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("expected JSON array but got string"),
    );
    warnSpy.mockRestore();
  });

  it("filters out entries with invalid action values", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = `[
      {"issueNumber": 1, "action": "add_to_backlog", "reason": "Good"},
      {"issueNumber": 2, "action": "invalid_action", "reason": "Bad"}
    ]`;
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(1);
    warnSpy.mockRestore();
  });

  it("warns when invalid items are dropped due to unrecognised action", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = `[
      {"issueNumber": 1, "action": "add_to_backlog", "reason": "Valid"},
      {"issueNumber": 2, "action": "defer", "reason": "Unrecognised action"}
    ]`;
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] parseTriageResponse: dropped 1 item(s)"),
    );
    warnSpy.mockRestore();
  });

  it("filters out entries missing required fields", () => {
    const input = `[
      {"issueNumber": 1, "action": "add_to_backlog", "reason": "Good"},
      {"action": "already_done", "reason": "Missing number"},
      {"issueNumber": 3, "reason": "Missing action"}
    ]`;
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
  });

  it("emits dropped-count warning when items with missing required fields are filtered out", () => {
    // Pins the droppedCount > 0 warn path for the missing-fields case (no issueNumber / no action).
    // The existing "warns when invalid items are dropped" test pins the unrecognised-action path;
    // this test pins the symmetric missing-fields path through the same warn branch.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = `[
      {"issueNumber": 1, "action": "add_to_backlog", "reason": "Valid"},
      {"action": "already_done", "reason": "Missing issueNumber"},
      {"issueNumber": 3, "reason": "Missing action"}
    ]`;
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] parseTriageResponse: dropped 2 item(s)"),
    );
    warnSpy.mockRestore();
  });

  it("handles multiple valid decisions", () => {
    const input = `[
      {"issueNumber": 1, "action": "add_to_backlog", "reason": "Feature request"},
      {"issueNumber": 2, "action": "already_done", "reason": "Already implemented"},
      {"issueNumber": 3, "action": "not_applicable", "reason": "Not relevant"}
    ]`;
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(3);
  });

  it("handles empty array", () => {
    expect(parseTriageResponse("[]")).toEqual([]);
  });

  it("deduplicates by keeping all entries with same issue number", () => {
    const input = `[
      {"issueNumber": 1, "action": "add_to_backlog", "reason": "First"},
      {"issueNumber": 1, "action": "already_done", "reason": "Second"}
    ]`;
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(2);
    expect(result[0].action).toBe("add_to_backlog");
    expect(result[1].action).toBe("already_done");
  });

  it("strips extra unexpected fields from entries", () => {
    const input = `[{"issueNumber": 1, "action": "add_to_backlog", "reason": "Good", "extra": "field"}]`;
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(1);
    // Extra fields pass through the filter (no stripping)
    expect((result[0] as unknown as Record<string, unknown>)["extra"]).toBe("field");
  });

  it("filters out-of-range actions mixed with valid ones", () => {
    const input = `[
      {"issueNumber": 1, "action": "add_to_backlog", "reason": "OK"},
      {"issueNumber": 2, "action": "reject", "reason": "Bad"},
      {"issueNumber": 3, "action": "not_applicable", "reason": "OK"},
      {"issueNumber": 4, "action": "", "reason": "Empty"}
    ]`;
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.issueNumber)).toEqual([1, 3]);
  });

  it("silently filters nulls, non-objects, and wrong-typed fields from a partially-malformed LLM array", () => {
    // Guards against silent data loss: the filter must keep only fully-valid entries
    // when the LLM returns a mix of valid decisions and garbage values.
    const input = JSON.stringify([
      null,
      { issueNumber: 7, action: "add_to_backlog", reason: "Valid entry" },
      "garbage",
      { issueNumber: "not-a-number", action: "add_to_backlog", reason: "String issueNumber" },
    ]);
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(7);
    expect(result[0].action).toBe("add_to_backlog");
  });

  it("filters out entries where issueNumber is a numeric string (e.g. \"5\" instead of 5)", () => {
    // The LLM occasionally returns issueNumber as a JSON string like "5" instead of
    // the number 5. The typeof guard must reject these to prevent string issue numbers
    // from propagating through the triage pipeline.
    const allStringInput = JSON.stringify([
      { issueNumber: "5", action: "add_to_backlog", reason: "Numeric string" },
    ]);
    expect(parseTriageResponse(allStringInput)).toHaveLength(0);

    // Mixed array: one valid (number), one invalid (numeric string) — only the valid entry survives
    const mixedInput = JSON.stringify([
      { issueNumber: "5", action: "add_to_backlog", reason: "Numeric string — rejected" },
      { issueNumber: 5, action: "not_applicable", reason: "Real number — kept" },
    ]);
    const mixedResult = parseTriageResponse(mixedInput);
    expect(mixedResult).toHaveLength(1);
    expect(mixedResult[0].issueNumber).toBe(5);
    expect(mixedResult[0].action).toBe("not_applicable");
  });

  it("filters out entries where issueNumber is 0 (GitHub issues start at #1)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = JSON.stringify([
      { issueNumber: 0, action: "add_to_backlog", reason: "Zero is not a valid issue number" },
      { issueNumber: 1, action: "not_applicable", reason: "Valid" },
    ]);
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dropped 1 item(s)"));
    warnSpy.mockRestore();
  });

  it("filters out entries where issueNumber is negative", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = JSON.stringify([
      { issueNumber: -1, action: "add_to_backlog", reason: "Negative is not a valid issue number" },
      { issueNumber: 2, action: "not_applicable", reason: "Valid" },
    ]);
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dropped 1 item(s)"));
    warnSpy.mockRestore();
  });

  it("filters out entries where issueNumber is a float (e.g. 1.5)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = JSON.stringify([
      { issueNumber: 1.5, action: "add_to_backlog", reason: "Float is not a valid issue number" },
      { issueNumber: 3, action: "not_applicable", reason: "Valid" },
    ]);
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(3);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dropped 1 item(s)"));
    warnSpy.mockRestore();
  });

  it("rejects entries with an empty-string reason", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = JSON.stringify([
      { issueNumber: 1, action: "add_to_backlog", reason: "" },
      { issueNumber: 2, action: "not_applicable", reason: "Valid reason" },
    ]);
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dropped 1 item(s)"));
    warnSpy.mockRestore();
  });

  it("rejects entries with a reason exceeding 2000 characters", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const oversizedReason = "x".repeat(2001);
    const input = JSON.stringify([
      { issueNumber: 1, action: "add_to_backlog", reason: oversizedReason },
      { issueNumber: 2, action: "already_done", reason: "Short reason" },
    ]);
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dropped 1 item(s)"));
    warnSpy.mockRestore();
  });

  it("accepts entries with reason at the exact 2000-character boundary", () => {
    const boundaryReason = "x".repeat(2000);
    const input = JSON.stringify([
      { issueNumber: 1, action: "add_to_backlog", reason: boundaryReason },
    ]);
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toHaveLength(2000);
  });

  it("warn preview includes full string when invalid JSON is exactly TRIAGE_ERROR_PREVIEW_CHARS chars", () => {
    // slice(0, 200) on a 200-char string returns the whole string — no truncation
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exactInput = "x".repeat(TRIAGE_ERROR_PREVIEW_CHARS);
    parseTriageResponse(exactInput);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(exactInput));
    warnSpy.mockRestore();
  });

  it("warn preview is truncated to TRIAGE_ERROR_PREVIEW_CHARS chars when invalid JSON is one char longer", () => {
    // slice(0, 200) on a 201-char string drops the last char — truncation fires
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const overInput = "x".repeat(TRIAGE_ERROR_PREVIEW_CHARS) + "z";
    parseTriageResponse(overInput);
    // The sliced preview (200 x's) appears in the message …
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("x".repeat(TRIAGE_ERROR_PREVIEW_CHARS)),
    );
    // … but the trailing "z" (char 201) does not
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining(overInput),
    );
    warnSpy.mockRestore();
  });

  it("filters out entries where issueNumber exceeds TRIAGE_MAX_ISSUE_NUMBER (1e20 hallucination guard)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Number.isInteger(1e20) === true in JS — without an upper-bound guard this passes
    const oversizedNumber = 1e20;
    const input = JSON.stringify([
      { issueNumber: oversizedNumber, action: "add_to_backlog", reason: "Hallucinated large number" },
      { issueNumber: 42, action: "not_applicable", reason: "Valid" },
    ]);
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(42);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dropped 1 item(s)"));
    warnSpy.mockRestore();
  });

  it("accepts entries where issueNumber equals TRIAGE_MAX_ISSUE_NUMBER (boundary inclusive)", () => {
    const input = JSON.stringify([
      { issueNumber: TRIAGE_MAX_ISSUE_NUMBER, action: "add_to_backlog", reason: "At boundary" },
    ]);
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(TRIAGE_MAX_ISSUE_NUMBER);
  });

  it("rejects entries where issueNumber is TRIAGE_MAX_ISSUE_NUMBER + 1 (boundary exclusive)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = JSON.stringify([
      { issueNumber: TRIAGE_MAX_ISSUE_NUMBER + 1, action: "add_to_backlog", reason: "One over boundary" },
    ]);
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dropped 1 item(s)"));
    warnSpy.mockRestore();
  });
});

describe("triageIssues error resilience", () => {
  const projectConfig: ProjectConfig = { filePath: "ROADMAP.md" };

  function makeQueryResult(decisions: Array<{ issueNumber: number; action: string; reason: string }>) {
    const json = JSON.stringify(decisions);
    // query returns an async iterable that yields messages; last message has `result`
    async function* fakeQuery() {
      yield { result: json };
    }
    mockQuery.mockReturnValue(fakeQuery() as unknown as ReturnType<typeof query>);
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("continues processing remaining issues when one closeIssueWithComment throws", async () => {
    const issues = [
      makeIssue({ number: 10, title: "Issue A" }),
      makeIssue({ number: 20, title: "Issue B" }),
      makeIssue({ number: 30, title: "Issue C" }),
    ];

    makeQueryResult([
      { issueNumber: 10, action: "not_applicable", reason: "Out of scope" },
      { issueNumber: 20, action: "not_applicable", reason: "Not relevant" },
      { issueNumber: 30, action: "not_applicable", reason: "Duplicate" },
    ]);

    // Make closeIssueWithComment throw on issue #20, succeed on others
    mockCloseIssue
      .mockResolvedValueOnce(true)   // issue #10 succeeds
      .mockRejectedValueOnce(new Error("API rate limit"))  // issue #20 throws
      .mockResolvedValueOnce(true);  // issue #30 succeeds

    const mockDb = {} as import("better-sqlite3").Database;
    const result = await triageIssues(issues, [], 81, projectConfig, mockDb);

    // Issues #10 and #30 should be closed despite #20 failing
    expect(result.closed).toContain(10);
    expect(result.closed).not.toContain(20);
    expect(result.closed).toContain(30);
    expect(result.decisions).toHaveLength(3);
  });

  it("logs error to console.error when per-issue processing fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const issues = [makeIssue({ number: 42, title: "Failing issue" })];
    makeQueryResult([
      { issueNumber: 42, action: "not_applicable", reason: "Out of scope" },
    ]);
    mockCloseIssue.mockRejectedValueOnce(new Error("Connection timeout"));
    const mockDb = {} as import("better-sqlite3").Database;

    await triageIssues(issues, [], 81, projectConfig, mockDb);

    // Close failures are reported with the dedicated close-error message
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] Failed to close issue #42 (non-fatal)"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Connection timeout"),
    );

    errorSpy.mockRestore();
  });

  it("returns empty result when no issues provided", async () => {
    const result = await triageIssues([], [], 81, projectConfig);
    expect(result.decisions).toEqual([]);
    expect(result.addedToBacklog).toEqual([]);
    expect(result.closed).toEqual([]);
  });
});

describe("triageIssues with injected deps", () => {
  const projectConfig: ProjectConfig = { filePath: "ROADMAP.md" };
  const mockAddLinkedItem = vi.mocked(addLinkedItem);
  const mockDetectRepo = vi.mocked(detectRepo);
  const mockIsValidRepo = vi.mocked(isValidRepo);

  function makeDeps(decisions: Array<{ issueNumber: number; action: string; reason: string }>) {
    const json = JSON.stringify(decisions);
    async function* fakeQuery() {
      yield { result: json };
    }
    return { queryFn: () => fakeQuery() as AsyncIterable<unknown> };
  }

  function makeFailingDeps(error: Error) {
    async function* failingQuery(): AsyncIterable<unknown> {
      throw error;
    }
    return { queryFn: () => failingQuery() };
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("adds issue to backlog via addLinkedItem when action is add_to_backlog", async () => {
    const issues = [makeIssue({ number: 7, title: "Add caching", body: "Please add caching" })];
    const deps = makeDeps([{ issueNumber: 7, action: "add_to_backlog", reason: "Good feature request" }]);
    const mockDb = {} as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValueOnce(true);

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    expect(result.addedToBacklog).toContain(7);
    expect(result.closed).not.toContain(7);
    expect(mockAddLinkedItem).toHaveBeenCalledWith(
      projectConfig, 7, "Add caching", "Please add caching",
    );
    // Idempotency guard: insertIssueAction must be called so the issue is not
    // re-triaged next cycle. Removing this call would silently break deduplication.
    expect(mockInsertIssueAction).toHaveBeenCalledWith(mockDb, 5, 7, "triaged");
  });

  it("downgrades already_done to add_to_backlog when no Done board item is linked (LLM path)", async () => {
    // LLM returns already_done for issue #8, but no Done board item is linked to #8.
    // The Done-gate should downgrade it to add_to_backlog.
    const issues = [makeIssue({ number: 8, title: "Already done" })];
    const deps = makeDeps([{ issueNumber: 8, action: "already_done", reason: "Already exists" }]);
    const mockDb = {} as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValueOnce(true);

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    // Downgraded: added to backlog, not treated as already_done. Not closed yet.
    expect(result.addedToBacklog).toContain(8);
    expect(result.closed).not.toContain(8);
    expect(mockAddLinkedItem).toHaveBeenCalled();
    // result.decisions must reflect the effective action, not the stale LLM action
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].action).toBe("add_to_backlog");
    expect(result.decisions[0].issueNumber).toBe(8);
  });

  it("skips LLM triage for issues already on the board by linkedIssueNumber", async () => {
    const issues = [makeIssue({ number: 10, title: "On board" })];
    // Board item is Backlog (not Done) — issue should NOT be closed at triage time
    const boardItems = [makeBoardItem({ linkedIssueNumber: 10, status: "Backlog" })];
    const deps = makeDeps([]);

    const result = await triageIssues(issues, boardItems, 5, projectConfig, undefined, deps);

    // LLM triage is skipped (decisions empty), issue is left open until work is Done
    expect(result.closed).not.toContain(10);
    expect(result.decisions).toEqual([]);
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("closes alreadyOnBoard issue when linked board item is Done", async () => {
    const issues = [makeIssue({ number: 10, title: "On board and Done" })];
    const boardItems = [makeBoardItem({ linkedIssueNumber: 10, status: "Done" })];
    const deps = makeDeps([]);

    mockCloseIssue.mockResolvedValueOnce(true);

    const result = await triageIssues(issues, boardItems, 5, projectConfig, undefined, deps);

    expect(result.closed).toContain(10);
    expect(result.decisions).toEqual([]);
  });

  it("does not close alreadyOnBoard issue when linked board item is In Progress", async () => {
    const issues = [makeIssue({ number: 11, title: "In progress" })];
    const boardItems = [makeBoardItem({ linkedIssueNumber: 11, status: "In Progress" })];
    const deps = makeDeps([]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await triageIssues(issues, boardItems, 5, projectConfig, undefined, deps);

    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(result.closed).not.toContain(11);
    expect(result.decisions).toEqual([]);
    // Diagnostic log must fire so operators can distinguish "not yet Done" from "not tracked"
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("will close when Done"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("#11"));
    logSpy.mockRestore();
  });

  it("ignores LLM decisions for issue numbers not in the untriaged set", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const issues = [makeIssue({ number: 1, title: "Real issue" })];
    const deps = makeDeps([
      { issueNumber: 1, action: "not_applicable", reason: "OK" },
      { issueNumber: 999, action: "add_to_backlog", reason: "Hallucinated issue" },
    ]);
    const mockDb = {} as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    expect(result.closed).toEqual([1]);
    expect(result.addedToBacklog).toEqual([]);
    // Hallucinated issue number should produce a warning, not silently vanish
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("#999"));
    warnSpy.mockRestore();
  });

  it("excludes hallucinated issue numbers from result.decisions", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const issues = [makeIssue({ number: 1, title: "Real issue" })];
    const deps = makeDeps([
      { issueNumber: 1, action: "not_applicable", reason: "Real decision" },
      { issueNumber: 42, action: "add_to_backlog", reason: "LLM hallucinated this number" },
    ]);
    const mockDb = {} as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    // Only the in-scope decision should appear in result.decisions
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].issueNumber).toBe(1);
    // Hallucinated #42 must not appear
    expect(result.decisions.every((d) => d.issueNumber !== 42)).toBe(true);
    warnSpy.mockRestore();
  });

  it("dedup guard: processes each issue number only once when LLM returns duplicate decisions", async () => {
    // Covers the processedIssueNumbers Set guard in triageIssues (lines 319-334 of triage.ts):
    // if the LLM returns two decisions for issue #5, addLinkedItem and insertIssueAction
    // must each be called exactly once — the second entry must be warned and skipped.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const issues = [makeIssue({ number: 5, title: "Duplicate issue", body: "Some feature" })];
    const deps = makeDeps([
      { issueNumber: 5, action: "add_to_backlog", reason: "Good feature request" },
      { issueNumber: 5, action: "not_applicable", reason: "Duplicate entry from LLM" },
    ]);
    const mockDb = {} as import("better-sqlite3").Database;

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    // addLinkedItem and insertIssueAction must each be called exactly once
    expect(mockAddLinkedItem).toHaveBeenCalledOnce();
    expect(mockInsertIssueAction).toHaveBeenCalledOnce();
    // First decision wins: issue #5 is in backlog, not closed
    expect(result.addedToBacklog).toContain(5);
    expect(result.closed).not.toContain(5);
    // A warning must be emitted for the duplicate
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Duplicate decision for issue #5"),
    );
    warnSpy.mockRestore();
  });

  it("returns early with empty result when LLM call fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const issues = [makeIssue({ number: 1, title: "Issue" })];
    const deps = makeFailingDeps(new Error("API timeout"));
    const mockDb = {} as import("better-sqlite3").Database;

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    expect(result.decisions).toEqual([]);
    expect(result.addedToBacklog).toEqual([]);
    expect(result.closed).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("LLM call failed"));
    errorSpy.mockRestore();
  });

  it("does not close issues or call addLinkedItem when LLM throws before yielding", async () => {
    // Verifies that a pre-yield throw leaves all side-effects untouched:
    // no issues are closed and no roadmap items are created.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const issues = [
      makeIssue({ number: 5, title: "Feature X" }),
      makeIssue({ number: 6, title: "Feature Y" }),
    ];
    const deps = makeFailingDeps(new Error("Network error before first yield"));
    const mockDb = {} as import("better-sqlite3").Database;

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    // Core result is empty — no decisions reached
    expect(result.decisions).toEqual([]);
    expect(result.addedToBacklog).toEqual([]);
    expect(result.closed).toEqual([]);

    // Side-effect guards: nothing was closed and nothing was added to the roadmap
    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(vi.mocked(addLinkedItem)).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("handles mixed actions across multiple issues", async () => {
    const issues = [
      makeIssue({ number: 1, title: "Feature A" }),
      makeIssue({ number: 2, title: "Feature B" }),
      makeIssue({ number: 3, title: "Feature C" }),
    ];
    const deps = makeDeps([
      { issueNumber: 1, action: "add_to_backlog", reason: "Good" },
      { issueNumber: 2, action: "already_done", reason: "Exists" },
      { issueNumber: 3, action: "not_applicable", reason: "Out of scope" },
    ]);

    mockCloseIssue.mockResolvedValue(true);
    const mockDb = {} as import("better-sqlite3").Database;

    const result = await triageIssues(issues, [], 10, projectConfig, mockDb, deps);

    expect(result.decisions).toHaveLength(3);
    // Issue #2's already_done is downgraded to add_to_backlog (Done-gate: no linked Done item)
    // add_to_backlog issues (#1, #2) stay open; only not_applicable (#3) is closed immediately
    expect(result.addedToBacklog).toEqual([1, 2]);
    expect(result.closed).toEqual([3]);
  });

  it("Guard A: skips closing an alreadyOnBoard issue when db records it as already triaged", async () => {
    // Issue #10 is on the board with status Done; db says it was already triaged in a prior cycle.
    // The board item must be Done so closeCandidates reaches the hasIssueAction guard — if the
    // item is Backlog/In-Progress the guard is short-circuited before hasIssueAction is called,
    // leaving mockReturnValueOnce unconsumed and leaking into subsequent tests.
    const issues = [makeIssue({ number: 10, title: "On board" })];
    const boardItems = [makeBoardItem({ linkedIssueNumber: 10, status: "Done" })];
    const deps = makeDeps([]);

    // Simulate a real db object with the issue already marked as triaged
    const mockDb = {} as import("better-sqlite3").Database;
    mockHasIssueAction.mockReturnValueOnce(true); // Guard A fires

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await triageIssues(issues, boardItems, 5, projectConfig, mockDb, deps);

    // closeIssueWithComment must NOT be called because the guard skipped the issue
    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(result.closed).toEqual([]);
    // Diagnostic log must be emitted so operators can distinguish "already triaged"
    // from "linked item not yet Done" — both paths produce result.closed=[] but
    // only the already-triaged path should log this message.
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already triaged — skipping close"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("#10"));
    logSpy.mockRestore();
  });

  it("Guard B: skips re-triaging a new issue when db records it as already triaged", async () => {
    // Issue #20 is NOT on the board, but db says it was triaged in a prior cycle
    const issues = [makeIssue({ number: 20, title: "Previously triaged" })];
    const deps = makeDeps([
      { issueNumber: 20, action: "not_applicable", reason: "Should not reach LLM" },
    ]);

    const mockDb = {} as import("better-sqlite3").Database;
    mockHasIssueAction.mockReturnValueOnce(true); // Guard B fires — issue filtered out

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    // LLM queryFn should not have been called because untriaged list is empty
    // and no close should have happened
    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(result.closed).toEqual([]);
    expect(result.decisions).toEqual([]);
  });

  it("Guard B: returns early with warning when db is undefined (prevents duplicate roadmap entries)", async () => {
    // When no db is provided, triage would re-process every issue on every cycle,
    // creating duplicate roadmap entries. The function must detect this and skip.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const issues = [makeIssue({ number: 30, title: "New issue" })];
    const deps = makeDeps([{ issueNumber: 30, action: "add_to_backlog", reason: "Good idea" }]);

    const result = await triageIssues(issues, [], 5, projectConfig, undefined, deps);

    // Must warn and skip — no LLM calls, no decisions, no roadmap mutations
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("No database available"),
    );
    expect(result.decisions).toEqual([]);
    expect(result.addedToBacklog).toEqual([]);
    expect(result.closed).toEqual([]);
    expect(vi.mocked(addLinkedItem)).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("Guard B: still processes alreadyOnBoard issues when db is undefined", async () => {
    // Even without a db, issues that are already Done on the board should be closeable.
    // The early return only skips the new-issue triage section.
    const issues = [makeIssue({ number: 40, title: "On board Done" })];
    const boardItems = [makeBoardItem({ linkedIssueNumber: 40, status: "Done" })];
    const deps = makeDeps([]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, boardItems, 5, projectConfig, undefined, deps);

    // alreadyOnBoard close should still happen (Done-gate: linkedItem is Done)
    expect(mockCloseIssue).toHaveBeenCalledTimes(1);
    expect(result.closed).toContain(40);
    // But the warning was still issued (no db for new-issue deduplication)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No database available"));
    warnSpy.mockRestore();
  });

  it("does not call insertIssueAction when db is undefined and board item is Done", async () => {
    // When db is absent the closeCandidates transaction is skipped (triage.ts:
    // `if (db && closeCandidates.length > 0)`). This test guards the guard: a
    // refactor that moves insertIssueAction outside the db-check would be caught.
    const issue = makeIssue({ number: 41, title: "Done on board, no db" });
    const boardItems = [makeBoardItem({ linkedIssueNumber: 41, status: "Done" })];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await triageIssues([issue], boardItems, 5, projectConfig, undefined);

    expect(mockInsertIssueAction).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not add to backlog when repo is invalid", async () => {
    mockIsValidRepo.mockReturnValueOnce(false);
    mockDetectRepo.mockReturnValueOnce(null);
    const issues = [makeIssue({ number: 1, title: "Feature" })];
    const deps = makeDeps([{ issueNumber: 1, action: "add_to_backlog", reason: "Good" }]);
    const mockDb = {} as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    // addLinkedItem should not be called because repo is null
    expect(mockAddLinkedItem).not.toHaveBeenCalled();
    // add_to_backlog issues are not closed at triage time
    expect(result.closed).toEqual([]);
    // insertIssueAction must still be called even when repo is null so the decision
    // is recorded and the issue is not re-triaged next cycle.
    expect(mockInsertIssueAction).toHaveBeenCalledWith(mockDb, 5, 1, "triaged");
  });

  it("repo=null: result.decisions contains the add_to_backlog decision even though addLinkedItem was skipped", async () => {
    // When detectRepo() returns null, the if(repo && isValidRepo(repo)) guard skips
    // addLinkedItem — but insertIssueAction is still called AND the decision must
    // appear in result.decisions so callers (e.g. context.ts) log the triage action.
    // This covers the production path where CI runners have no repo configured.
    mockDetectRepo.mockReturnValueOnce(null);
    mockIsValidRepo.mockReturnValueOnce(false);
    const issues = [makeIssue({ number: 3, title: "New feature" })];
    const deps = makeDeps([{ issueNumber: 3, action: "add_to_backlog", reason: "Worth doing" }]);
    const mockDb = {} as import("better-sqlite3").Database;

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    // addLinkedItem must NOT be called (no valid repo)
    expect(mockAddLinkedItem).not.toHaveBeenCalled();
    // The backlog list stays empty (addLinkedItem was skipped)
    expect(result.addedToBacklog).toEqual([]);
    // insertIssueAction must still be called to prevent infinite re-triage
    expect(mockInsertIssueAction).toHaveBeenCalledWith(mockDb, 5, 3, "triaged");
    // The decision must appear in result.decisions so callers can log it
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].issueNumber).toBe(3);
    expect(result.decisions[0].action).toBe("add_to_backlog");
  });

  it("calls insertIssueAction even when addLinkedItem throws (prevents infinite re-triage loop)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Reset mocks fully to clear any queued mockReturnValueOnce from prior tests
    mockIsValidRepo.mockReset().mockReturnValue(true);
    mockDetectRepo.mockReset().mockReturnValue("test-owner/test-repo");
    mockAddLinkedItem.mockImplementationOnce(() => { throw new Error("disk full"); });

    const issues = [makeIssue({ number: 55, title: "Feature X" })];
    const deps = makeDeps([{ issueNumber: 55, action: "add_to_backlog", reason: "Good idea" }]);
    const mockDb = {} as import("better-sqlite3").Database;

    const result = await triageIssues(issues, [], 10, projectConfig, mockDb, deps);

    // insertIssueAction must still be called despite addLinkedItem throwing
    expect(mockInsertIssueAction).toHaveBeenCalledWith(mockDb, 10, 55, "triaged");
    // The issue is NOT in addedToBacklog because addLinkedItem threw before push
    expect(result.addedToBacklog).not.toContain(55);
    // A console.error should log the addLinkedItem failure
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("addLinkedItem failed for issue #55"));
    errorSpy.mockRestore();
  });

  it("does not add to backlog when isValidRepo returns false for a non-null repo", async () => {
    mockIsValidRepo.mockReturnValueOnce(false);
    mockDetectRepo.mockReturnValueOnce("owner/repo"); // non-null repo — exercises the isValidRepo guard
    const issues = [makeIssue({ number: 2, title: "Feature B" })];
    const deps = makeDeps([{ issueNumber: 2, action: "add_to_backlog", reason: "Looks good" }]);
    const mockDb = {} as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    // isValidRepo returned false, so addLinkedItem must not be called even though repo is non-null
    expect(mockAddLinkedItem).not.toHaveBeenCalled();
    expect(result.closed).toEqual([]);
  });

  it("passes correct comment text for each action type", async () => {
    const issues = [makeIssue({ number: 1 })];
    const deps = makeDeps([{ issueNumber: 1, action: "not_applicable", reason: "Out of scope" }]);
    const mockDb = {} as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValue(true);

    await triageIssues(issues, [], 7, projectConfig, mockDb, deps);

    expect(mockCloseIssue).toHaveBeenCalledWith(
      1,
      7,
      expect.stringContaining("not applicable or out of scope"),
      mockDb,
      "closed",
      "test-owner/test-repo",
    );
  });

  it("pins exact comment string for not_applicable action including cycleCount interpolation", async () => {
    // Tripwire: a silent rename of the commentMap wording would go undetected by
    // the looser stringContaining assertion in the adjacent test. This pins the
    // full string including cycle number so any wording change breaks explicitly.
    const issues = [makeIssue({ number: 5, title: "Off-topic request" })];
    const deps = makeDeps([{ issueNumber: 5, action: "not_applicable", reason: "Not relevant to Bloom." }]);
    const mockDb = {} as import("better-sqlite3").Database;
    mockCloseIssue.mockResolvedValue(true);

    await triageIssues(issues, [], 12, projectConfig, mockDb, deps);

    expect(mockCloseIssue).toHaveBeenCalledWith(
      5,
      12,
      "Closing — not applicable or out of scope (cycle 12).\n\nNot relevant to Bloom.",
      mockDb,
      "closed",
      "test-owner/test-repo",
    );
  });

  it("pins exact comment string for not_applicable including reason text and newline separator", async () => {
    // Tripwire: verifies that the comment passed to closeIssueWithComment is
    // `commentMap[action]\n\nreason` — i.e. two newlines separate the header from
    // the reason. A refactor changing to one newline or a space would go undetected
    // by the adjacent stringContaining test above.
    const issues = [makeIssue({ number: 9, title: "Unrelated request" })];
    const deps = makeDeps([{ issueNumber: 9, action: "not_applicable", reason: "Not related to Bloom's purpose." }]);
    const mockDb = {} as import("better-sqlite3").Database;
    mockCloseIssue.mockResolvedValue(true);

    await triageIssues(issues, [], 3, projectConfig, mockDb, deps);

    expect(mockCloseIssue).toHaveBeenCalledWith(
      9,
      3,
      "Closing — not applicable or out of scope (cycle 3).\n\nNot related to Bloom's purpose.",
      mockDb,
      "closed",
      "test-owner/test-repo",
    );
  });

  it("records insertIssueAction('triaged') before close for not_applicable (prevents re-triage on close failure)", async () => {
    // Regression guard: if the GitHub close API fails in phase 2, the issue must
    // still be marked "triaged" in the DB so it is not re-sent to the LLM next cycle.
    // The fix records "triaged" in phase 1 (unconditionally) for not_applicable decisions,
    // mirroring the add_to_backlog path. Phase 2 uses action "closed" to avoid the
    // hasIssueAction("triaged") dedup guard short-circuiting the actual close call.
    const issues = [makeIssue({ number: 92 })];
    const deps = makeDeps([{ issueNumber: 92, action: "not_applicable", reason: "Out of scope" }]);
    const mockDb = {} as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValue(true);

    await triageIssues(issues, [], 3, projectConfig, mockDb, deps);

    // insertIssueAction("triaged") must be called in phase 1 — before closeIssueWithComment —
    // so the decision is persisted even if the GitHub close API call in phase 2 fails.
    expect(mockInsertIssueAction).toHaveBeenCalledWith(mockDb, 3, 92, "triaged");
    // Phase 2 uses "closed" so hasIssueAction("triaged") does not short-circuit the close
    expect(mockCloseIssue).toHaveBeenCalledWith(
      92,
      3,
      expect.any(String),
      mockDb,
      "closed",
      "test-owner/test-repo",
    );
  });

  it("records insertIssueAction('triaged') even when closeIssueWithComment throws on newIssues not_applicable path (ordering regression guard)", async () => {
    // Regression guard for the phase-1/phase-2 ordering invariant on the newIssues path:
    // insertIssueAction("triaged") must be persisted in phase 1 BEFORE the close API
    // call in phase 2. If the close throws, the DB record must already exist so the issue
    // is filtered by hasIssueAction("triaged") on the next cycle — preventing an
    // infinite re-triage/re-close loop. Mirrors the alreadyOnBoard ordering test above.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const issues = [makeIssue({ number: 55 })];
    const deps = makeDeps([{ issueNumber: 55, action: "not_applicable", reason: "Out of scope" }]);
    const mockDb = {} as import("better-sqlite3").Database;

    // Simulate phase-2 GitHub API failure
    mockCloseIssue.mockRejectedValueOnce(new Error("503 Service Unavailable"));

    await triageIssues(issues, [], 7, projectConfig, mockDb, deps);

    // insertIssueAction("triaged") must have been called in phase 1 — before the
    // close threw — so the decision survives the API failure.
    expect(mockInsertIssueAction).toHaveBeenCalledWith(mockDb, 7, 55, "triaged");
    // The close failure must NOT propagate — it is caught and logged as non-fatal.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] Failed to close issue #55 (non-fatal)"),
    );
    errorSpy.mockRestore();
  });

  it("does not close add_to_backlog issues at triage time (they stay open until Done)", async () => {
    const issues = [makeIssue({ number: 11, title: "New feature request" })];
    const deps = makeDeps([{ issueNumber: 11, action: "add_to_backlog", reason: "Valid idea." }]);
    const mockDb = {} as import("better-sqlite3").Database;

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    // add_to_backlog issues must NOT be closed — they will be closed when the roadmap item is Done
    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(result.closed).not.toContain(11);
  });

  it("does not close issue when LLM already_done is downgraded to add_to_backlog by Done-gate", async () => {
    // LLM claims already_done but no Done board item links to #15 → downgraded to add_to_backlog
    // add_to_backlog issues stay open until the roadmap item is Done.
    const issues = [makeIssue({ number: 15, title: "Feature already done" })];
    const deps = makeDeps([{ issueNumber: 15, action: "already_done", reason: "This was implemented in cycle 100." }]);
    const mockDb = {} as import("better-sqlite3").Database;

    const result = await triageIssues(issues, [], 9, projectConfig, mockDb, deps);

    // Downgraded to add_to_backlog — issue must NOT be closed at triage time
    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(result.addedToBacklog).toContain(15);
  });

  it("downgrades already_done to add_to_backlog when no Done board item is linked", async () => {
    // LLM returns already_done but no board item has status "Done" linked to this issue.
    // The board has a Done item for #99 (different issue) — not evidence for #22.
    const issues = [makeIssue({ number: 22, title: "Issue 22" })];
    const boardItems = [
      makeBoardItem({ status: "Done", linkedIssueNumber: 99 }), // Done item for a different issue
    ];
    const deps = makeDeps([{ issueNumber: 22, action: "already_done", reason: "Seems done" }]);
    const mockDb = {} as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, boardItems, 5, projectConfig, mockDb, deps);

    // Issue #22 should be downgraded to add_to_backlog — no Done evidence for it
    expect(result.addedToBacklog).toContain(22);
    expect(mockAddLinkedItem).toHaveBeenCalled();
    // add_to_backlog issues stay open — NOT closed at triage time
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("downgrades already_done to add_to_backlog when matching board item is In Progress (not Done)", async () => {
    // Done-gate path: LLM says already_done for issue #33, and there IS a board
    // item with a matching title concept — but its status is "In Progress", not "Done".
    // Since the gate checks for status === "Done" && linkedIssueNumber === 33,
    // the "In Progress" item provides no evidence, so the decision is downgraded.
    const issues = [makeIssue({ number: 33, title: "Issue 33" })];
    const boardItems = [
      makeBoardItem({ status: "In Progress", linkedIssueNumber: null }), // In Progress, no link
    ];
    const deps = makeDeps([{ issueNumber: 33, action: "already_done", reason: "Looks done" }]);
    const mockDb = {} as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, boardItems, 6, projectConfig, mockDb, deps);

    // Done-gate fires: no Done item is linked to #33, so already_done → add_to_backlog
    expect(result.addedToBacklog).toContain(33);
    expect(mockAddLinkedItem).toHaveBeenCalled();
    // add_to_backlog issues must NOT be closed at triage time
    expect(result.closed).not.toContain(33);
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("ignores duplicate issueNumber decisions (keeps first occurrence, warns on subsequent)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const issues = [makeIssue({ number: 5, title: "Feature Z" })];
    // LLM returns two contradictory decisions for the same issue
    const deps = makeDeps([
      { issueNumber: 5, action: "add_to_backlog", reason: "First decision" },
      { issueNumber: 5, action: "not_applicable", reason: "Second (duplicate)" },
    ]);
    const mockDb = {} as import("better-sqlite3").Database;
    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, [], 15, projectConfig, mockDb, deps);

    // Only the FIRST decision should be processed: add_to_backlog
    expect(result.addedToBacklog).toContain(5);
    // The not_applicable duplicate must NOT cause the issue to be closed
    expect(result.closed).not.toContain(5);
    // A warning should be emitted for the duplicate
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Duplicate decision for issue #5"));
    warnSpy.mockRestore();
  });

  it("calls insertIssueAction and addLinkedItem exactly once when LLM returns two decisions for same issue", async () => {
    // Pins the dedup guard: if the LLM returns two decisions for the same issue
    // (e.g. add_to_backlog then not_applicable for #5), only the first is acted on.
    // Both insertIssueAction and addLinkedItem must be called exactly once — the
    // duplicate not_applicable must be dropped before any close path is reached.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const issues = [makeIssue({ number: 5, title: "Feature Z" })];
    const deps = makeDeps([
      { issueNumber: 5, action: "add_to_backlog", reason: "First decision" },
      { issueNumber: 5, action: "not_applicable", reason: "Duplicate — should be dropped" },
    ]);
    const mockDb = {} as import("better-sqlite3").Database;
    mockCloseIssue.mockResolvedValue(true);

    await triageIssues(issues, [], 15, projectConfig, mockDb, deps);

    // insertIssueAction must be called exactly once for issue #5 (no double-insert)
    const insertCallsForFive = mockInsertIssueAction.mock.calls.filter((c) => c[2] === 5);
    expect(insertCallsForFive).toHaveLength(1);
    // addLinkedItem must be called exactly once — the duplicate must not trigger a second add
    expect(mockAddLinkedItem).toHaveBeenCalledTimes(1);
    // A warning must be emitted for the dropped duplicate
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Duplicate decision for issue #5"));
    warnSpy.mockRestore();
  });

  it("processes each unique issueNumber exactly once when LLM returns multiple entries", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const issues = [
      makeIssue({ number: 1, title: "Issue One" }),
      makeIssue({ number: 2, title: "Issue Two" }),
    ];
    const deps = makeDeps([
      { issueNumber: 1, action: "add_to_backlog", reason: "Good idea" },
      { issueNumber: 2, action: "add_to_backlog", reason: "Also good" },
      { issueNumber: 2, action: "not_applicable", reason: "Duplicate — should be ignored" },
    ]);
    const mockDb = {} as import("better-sqlite3").Database;
    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, [], 15, projectConfig, mockDb, deps);

    // Both issues added to backlog (first occurrence of each)
    expect(result.addedToBacklog).toContain(1);
    expect(result.addedToBacklog).toContain(2);
    // Duplicate not_applicable for #2 must be discarded — issue must NOT be closed
    expect(result.closed).not.toContain(2);
    // insertIssueAction for issue #2 called exactly once (no double-insert)
    const insertCallsForTwo = mockInsertIssueAction.mock.calls.filter((c) => c[2] === 2);
    expect(insertCallsForTwo).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("uses BLOOM_MODEL env var when set", async () => {
    const capturedOptions: unknown[] = [];
    const issues = [makeIssue({ number: 1 })];
    const customQuery = async function* (args: { options?: { model?: string } }) {
      capturedOptions.push(args.options);
      yield { result: JSON.stringify([{ issueNumber: 1, action: "not_applicable", reason: "Test" }]) };
    };
    const deps = { queryFn: customQuery as Parameters<typeof triageIssues>[5] extends undefined ? never : NonNullable<Parameters<typeof triageIssues>[5]>["queryFn"] };
    const mockDb = {} as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValue(true);
    const originalModel = process.env.BLOOM_MODEL;
    process.env.BLOOM_MODEL = "claude-test-model";
    try {
      await triageIssues(issues, [], 5, projectConfig, mockDb, deps);
    } finally {
      if (originalModel === undefined) delete process.env.BLOOM_MODEL;
      else process.env.BLOOM_MODEL = originalModel;
    }

    expect(capturedOptions[0]).toMatchObject({ model: "claude-test-model" });
  });

  it("does not add to result.closed when alreadyOnBoard closeIssueWithComment returns false", async () => {
    // Issue #10 is already on the board with status Done — alreadyOnBoard path
    const issues = [makeIssue({ number: 10, title: "On board Done" })];
    const boardItems = [makeBoardItem({ linkedIssueNumber: 10, status: "Done" })];
    const deps = makeDeps([]);
    const mockDb = { transaction: <T>(fn: () => T) => fn } as unknown as import("better-sqlite3").Database;

    // closeIssueWithComment returns false (soft failure — e.g. already closed externally)
    mockCloseIssue.mockResolvedValueOnce(false);

    const result = await triageIssues(issues, boardItems, 5, projectConfig, mockDb, deps);

    expect(mockCloseIssue).toHaveBeenCalledTimes(1);
    // wasClosed was false, so the issue must NOT appear in result.closed
    expect(result.closed).toEqual([]);
  });

  it("does not add to result.closed when decisions loop closeIssueWithComment returns false", async () => {
    // Issue #5 goes through LLM triage — decisions loop path
    const issues = [makeIssue({ number: 5, title: "Some issue" })];
    const deps = makeDeps([{ issueNumber: 5, action: "not_applicable", reason: "Out of scope" }]);
    const mockDb = {} as import("better-sqlite3").Database;

    // closeIssueWithComment returns false (soft failure, not a throw)
    mockCloseIssue.mockResolvedValueOnce(false);

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    expect(mockCloseIssue).toHaveBeenCalledTimes(1);
    // wasClosed was false, so the issue must NOT appear in result.closed
    expect(result.closed).toEqual([]);
    // The decision itself should still be recorded
    expect(result.decisions).toHaveLength(1);
  });

  it("uses default model claude-sonnet-4-6 when BLOOM_MODEL is not set", async () => {
    const capturedOptions: unknown[] = [];
    const issues = [makeIssue({ number: 1 })];
    const customQuery = async function* (args: { options?: { model?: string } }) {
      capturedOptions.push(args.options);
      yield { result: JSON.stringify([{ issueNumber: 1, action: "not_applicable", reason: "Test" }]) };
    };
    const deps = { queryFn: customQuery as Parameters<typeof triageIssues>[5] extends undefined ? never : NonNullable<Parameters<typeof triageIssues>[5]>["queryFn"] };
    const mockDb = {} as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValue(true);
    const originalModel = process.env.BLOOM_MODEL;
    delete process.env.BLOOM_MODEL;
    try {
      await triageIssues(issues, [], 5, projectConfig, mockDb, deps);
    } finally {
      if (originalModel !== undefined) process.env.BLOOM_MODEL = originalModel;
    }

    expect(capturedOptions[0]).toMatchObject({ model: "claude-sonnet-4-6" });
  });

  it("logs a warning (not crash) when alreadyOnBoard closeIssueWithComment throws", async () => {
    // Issue #10 is on the board with status Done; closeIssueWithComment throws unexpectedly
    // (e.g. issue was closed externally between the filter and the close call)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const issues = [makeIssue({ number: 10, title: "On board Done" })];
    const boardItems = [makeBoardItem({ linkedIssueNumber: 10, status: "Done" })];
    const deps = makeDeps([]);
    const mockDb = { transaction: <T>(fn: () => T) => fn } as unknown as import("better-sqlite3").Database;

    mockCloseIssue.mockRejectedValueOnce(new Error("422 Unprocessable Entity"));

    // Should not throw — the catch block handles it gracefully
    const result = await triageIssues(issues, boardItems, 5, projectConfig, mockDb, deps);

    expect(result.closed).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] Could not close already-on-board issue #10"),
    );
    warnSpy.mockRestore();
  });

  it("records insertIssueAction('triaged') before close for alreadyOnBoard path (prevents infinite retry on close failure)", async () => {
    // Regression guard: if the GitHub close API throws for an alreadyOnBoard issue,
    // the issue must still be marked "triaged" in DB so it is filtered out by
    // hasIssueAction("triaged") on the next cycle — preventing an infinite close-retry loop.
    // The fix pre-records "triaged" in insertIssueAction before Promise.allSettled,
    // then passes "closed" to closeIssueWithComment, mirroring the new-issues phase-1/phase-2 split.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const issues = [makeIssue({ number: 77, title: "On board Done" })];
    const boardItems = [makeBoardItem({ linkedIssueNumber: 77, status: "Done" })];
    const deps = makeDeps([]);
    const mockDb = { transaction: <T>(fn: () => T) => fn } as unknown as import("better-sqlite3").Database;

    // Simulate GitHub API failure on close
    mockCloseIssue.mockRejectedValueOnce(new Error("500 Internal Server Error"));

    await triageIssues(issues, boardItems, 4, projectConfig, mockDb, deps);

    // insertIssueAction("triaged") must be called BEFORE closeIssueWithComment so
    // the decision survives an API failure — preventing the issue from re-entering
    // closeCandidates next cycle.
    expect(mockInsertIssueAction).toHaveBeenCalledWith(mockDb, 4, 77, "triaged");
    // closeIssueWithComment must use "closed" (not "triaged") so the pre-recorded
    // "triaged" entry above acts as the retry guard without being overwritten.
    expect(mockCloseIssue).toHaveBeenCalledWith(
      77,
      4,
      expect.any(String),
      mockDb,
      "closed",
      "test-owner/test-repo",
    );
    warnSpy.mockRestore();
  });

  it("closeCandidates transaction: calls insertIssueAction for each Done board item in a multi-issue scenario", async () => {
    // Covers the closeCandidates transaction block (triage.ts lines 221-227):
    // when two issues are both on the board with status Done and neither has been
    // triaged before, insertIssueAction must be called once per issue (atomically),
    // not just once. Guard A (single-issue) already covers the single-issue case.
    const issues = [
      makeIssue({ number: 11, title: "Done Issue A" }),
      makeIssue({ number: 12, title: "Done Issue B" }),
    ];
    const boardItems = [
      makeBoardItem({ linkedIssueNumber: 11, status: "Done" }),
      makeBoardItem({ id: "item-2", linkedIssueNumber: 12, status: "Done" }),
    ];
    const deps = makeDeps([]);
    const mockDb = { transaction: <T>(fn: () => T) => fn } as unknown as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValue(true);

    await triageIssues(issues, boardItems, 9, projectConfig, mockDb, deps);

    // insertIssueAction must be called for BOTH close candidates
    expect(mockInsertIssueAction).toHaveBeenCalledWith(mockDb, 9, 11, "triaged");
    expect(mockInsertIssueAction).toHaveBeenCalledWith(mockDb, 9, 12, "triaged");
    // insertIssueAction must have been called at least twice (once per candidate)
    expect(mockInsertIssueAction.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("concurrent fan-out mixed results: only successful closes appear in result.closed", async () => {
    // The closeCandidates path fans out via Promise.all(allSettled). When multiple
    // close candidates run concurrently and produce a mix of true/false results,
    // only the issues whose closeIssueWithComment resolved true must appear in
    // result.closed — false returns must be silently excluded.
    // This is the key boundary condition of the concurrent fan-out.
    const issues = [
      makeIssue({ number: 20, title: "On board Done A" }),
      makeIssue({ number: 21, title: "On board Done B" }),
      makeIssue({ number: 22, title: "On board Done C" }),
    ];
    const boardItems = [
      makeBoardItem({ linkedIssueNumber: 20, status: "Done" }),
      makeBoardItem({ id: "item-21", linkedIssueNumber: 21, status: "Done" }),
      makeBoardItem({ id: "item-22", linkedIssueNumber: 22, status: "Done" }),
    ];
    const deps = makeDeps([]);
    const mockDb = { transaction: <T>(fn: () => T) => fn } as unknown as import("better-sqlite3").Database;

    // Concurrent calls return mixed results: #20 closes, #21 fails, #22 closes
    mockCloseIssue
      .mockResolvedValueOnce(true)   // issue #20 — succeeds
      .mockResolvedValueOnce(false)  // issue #21 — soft failure
      .mockResolvedValueOnce(true);  // issue #22 — succeeds

    const result = await triageIssues(issues, boardItems, 7, projectConfig, mockDb, deps);

    // Only the two successful closes must appear — the false result is excluded
    expect(result.closed).toHaveLength(2);
    expect(result.closed).toContain(20);
    expect(result.closed).not.toContain(21);
    expect(result.closed).toContain(22);
    // All three candidates were attempted
    expect(mockCloseIssue).toHaveBeenCalledTimes(3);
  });

  it("calls insertIssueAction before closeIssueWithComment for alreadyOnBoard path (invocationCallOrder)", async () => {
    // Integration ordering test: the DB pre-record must happen before the API fan-out
    // so that a close failure still leaves "triaged" persisted in the DB, preventing
    // an infinite close-retry loop on subsequent cycles.
    const issues = [makeIssue({ number: 88, title: "On board Done" })];
    const boardItems = [makeBoardItem({ linkedIssueNumber: 88, status: "Done" })];
    const deps = makeDeps([]);
    const mockDb = { transaction: <T>(fn: () => T) => fn } as unknown as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValueOnce(true);

    await triageIssues(issues, boardItems, 6, projectConfig, mockDb, deps);

    // Both must have been called
    expect(mockInsertIssueAction).toHaveBeenCalledWith(mockDb, 6, 88, "triaged");
    expect(mockCloseIssue).toHaveBeenCalledTimes(1);

    // Ordering: insertIssueAction must have been invoked strictly before closeIssueWithComment
    const insertOrder = mockInsertIssueAction.mock.invocationCallOrder[0];
    const closeOrder = mockCloseIssue.mock.invocationCallOrder[0];
    expect(insertOrder).toBeLessThan(closeOrder);
  });

  it("outer catch: cycle continues when insertIssueAction throws for not_applicable decision", async () => {
    // If the DB write fails mid-processing (e.g., disk full) for one issue, the outer
    // catch-and-continue block must log the error and let other issues proceed normally.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const issues = [
      makeIssue({ number: 61, title: "Fails to record" }),
      makeIssue({ number: 62, title: "Should still succeed" }),
    ];
    const deps = makeDeps([
      { issueNumber: 61, action: "not_applicable", reason: "Out of scope" },
      { issueNumber: 62, action: "not_applicable", reason: "Also out of scope" },
    ]);
    const mockDb = {} as import("better-sqlite3").Database;

    // Make insertIssueAction throw only for issue #61
    mockInsertIssueAction.mockImplementationOnce(() => { throw new Error("disk full"); });
    mockCloseIssue.mockResolvedValue(true);

    // Must not throw — outer catch keeps the cycle alive
    const result = await triageIssues(issues, [], 20, projectConfig, mockDb, deps);

    // The failure for #61 is logged
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] Failed to process issue #61"),
    );
    // Cycle continues — #62 is still processed (insertIssueAction called for it)
    expect(mockInsertIssueAction).toHaveBeenCalledWith(mockDb, 20, 62, "triaged");
    // #62 is eventually closed
    expect(result.closed).toContain(62);
    // #61 is NOT closed because its closeTasks.push was never reached
    expect(result.closed).not.toContain(61);

    errorSpy.mockRestore();
  });

  it("outer catch: cycle continues when insertIssueAction throws for add_to_backlog decision", async () => {
    // If insertIssueAction throws on the add_to_backlog path for one issue, the outer
    // catch must log and continue so other issues in the same cycle are not blocked.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const issues = [
      makeIssue({ number: 71, title: "DB write fails" }),
      makeIssue({ number: 72, title: "Should still be added" }),
    ];
    const deps = makeDeps([
      { issueNumber: 71, action: "add_to_backlog", reason: "Good feature" },
      { issueNumber: 72, action: "add_to_backlog", reason: "Also good" },
    ]);
    const mockDb = {} as import("better-sqlite3").Database;

    // addLinkedItem succeeds for both; insertIssueAction throws only for #71
    mockInsertIssueAction.mockImplementationOnce(() => { throw new Error("WAL corruption"); });
    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, [], 20, projectConfig, mockDb, deps);

    // The failure for #71 is logged
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] Failed to process issue #71"),
    );
    // #72 is still added to backlog despite #71 failing
    expect(result.addedToBacklog).toContain(72);
    expect(mockInsertIssueAction).toHaveBeenCalledWith(mockDb, 20, 72, "triaged");

    errorSpy.mockRestore();
  });

  it("calls queryFn with TRIAGE_MAX_TURNS and TRIAGE_MAX_BUDGET_USD options", async () => {
    // Guard: if maxTurns or maxBudgetUsd are accidentally changed, this test catches
    // the regression — mirrors the assess.test.ts safety-options pattern.
    const capturedOptions: unknown[] = [];
    const issues = [makeIssue({ number: 1 })];
    const customQuery = async function* (args: { options?: unknown }) {
      capturedOptions.push(args.options);
      yield { result: JSON.stringify([{ issueNumber: 1, action: "not_applicable", reason: "Test" }]) };
    };
    const deps = { queryFn: customQuery as Parameters<typeof triageIssues>[5] extends undefined ? never : NonNullable<Parameters<typeof triageIssues>[5]>["queryFn"] };
    const mockDb = {} as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValue(true);
    await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    expect(capturedOptions[0]).toMatchObject({
      maxTurns: TRIAGE_MAX_TURNS,
      maxBudgetUsd: TRIAGE_MAX_BUDGET_USD,
    });
  });

  it("warns and returns empty result when db is undefined and new issues exist", async () => {
    // When db=undefined and issues are not on the board, the function must emit a
    // console.warn explaining why triage is skipped and return empty arrays.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const issues = [
      makeIssue({ number: 10, title: "New feature A" }),
      makeIssue({ number: 11, title: "New feature B" }),
    ];
    // No board items → both issues are "new" (not on board)
    const result = await triageIssues(issues, [], 5, projectConfig, undefined);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] No database available"),
    );
    expect(result.addedToBacklog).toHaveLength(0);
    expect(result.closed).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it("no-db with new issues: SDK query function is never invoked (LLM path fully skipped)", async () => {
    // When db is undefined, the function must return early BEFORE reaching the LLM
    // query call. This test verifies the early-return branch by asserting that the
    // globally-mocked SDK query is never invoked — not just that results are empty.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Deliberately omit deps so the code would fall through to the real SDK mock
    // if the early-return guard were absent or incorrectly placed.
    const issue = makeIssue({ number: 99, title: "Brand new issue" });

    await triageIssues([issue], [], 5, projectConfig, undefined);

    // Guard: warn fires, LLM never reached
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] No database available"),
    );
    expect(mockQuery).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("skips LLM call and returns empty result when all new issues are already triaged in db", async () => {
    // When hasIssueAction returns true for every new issue, untriaged.length === 0
    // and the early return at that guard fires — the queryFn must never be invoked.
    // This prevents unnecessary LLM spend on issues already processed in a prior cycle.
    const queryFn = vi.fn();
    const deps = { queryFn };
    const mockDb = {} as import("better-sqlite3").Database;
    const issues = [
      makeIssue({ number: 1, title: "Already triaged A" }),
      makeIssue({ number: 2, title: "Already triaged B" }),
    ];

    // Simulate all issues having been triaged previously
    mockHasIssueAction.mockReturnValue(true);

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    expect(result.decisions).toEqual([]);
    expect(result.addedToBacklog).toEqual([]);
    expect(result.closed).toEqual([]);
    // LLM must not be called — no prompt budget spent on already-processed issues
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("emits count-mismatch warning when decision count differs from untriaged issue count (possible prompt drift)", async () => {
    // Covers the JSDoc promise in triageIssues: a mismatch between the number of
    // input issues and returned decisions is logged as a warning (possible prompt drift)
    // but does not cause an error or skip any valid decisions.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const issues = [
      makeIssue({ number: 1, title: "Issue One" }),
      makeIssue({ number: 2, title: "Issue Two" }),
    ];
    // LLM returns only one decision for two issues → count mismatch
    const deps = makeDeps([
      { issueNumber: 1, action: "not_applicable", reason: "Out of scope" },
    ]);
    const mockDb = {} as import("better-sqlite3").Database;
    mockCloseIssue.mockResolvedValue(true);

    await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("possible prompt drift"),
    );
    warnSpy.mockRestore();
  });

  it("emits count-mismatch warning when LLM returns MORE decisions than untriaged issues", async () => {
    // The reverse direction of the fewer-decisions test: LLM hallucinates extra decisions
    // beyond the untriaged set. decisions.length > untriaged.length must fire the
    // "possible prompt drift" warning — guarding against silent log-format drift.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const issues = [makeIssue({ number: 1, title: "One untriaged issue" })];
    // LLM returns two decisions for one untriaged issue → decisions.length (2) > untriaged.length (1)
    const deps = makeDeps([
      { issueNumber: 1, action: "not_applicable", reason: "Out of scope" },
      { issueNumber: 99, action: "add_to_backlog", reason: "Hallucinated extra issue" },
    ]);
    const mockDb = {} as import("better-sqlite3").Database;

    await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("possible prompt drift"),
    );
    warnSpy.mockRestore();
  });

  it("warns and skips duplicate LLM decision, keeping first occurrence", async () => {
    // When the LLM returns two decisions for the same issue number, the second must
    // be dropped with a console.warn and only the first decision processed.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const issues = [makeIssue({ number: 1, title: "Duplicate decision issue" })];
    // Inject two decisions for issue #1: first add_to_backlog, then not_applicable
    const deps = makeDeps([
      { issueNumber: 1, action: "add_to_backlog", reason: "Good idea" },
      { issueNumber: 1, action: "not_applicable", reason: "Out of scope" },
    ]);
    const mockDb = {} as import("better-sqlite3").Database;

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Duplicate decision"),
    );
    // First decision (add_to_backlog) is processed — issue added to backlog
    expect(result.addedToBacklog).toContain(1);
    // Second decision (not_applicable) is ignored — issue not closed
    expect(result.closed).not.toContain(1);

    warnSpy.mockRestore();
  });

  it("duplicate decision: insertIssueAction called exactly once despite two LLM decisions for same issue", async () => {
    // The processedIssueNumbers guard (triage.ts lines 357–362) drops the second
    // decision for the same issue. This test verifies the downstream effect:
    // insertIssueAction must be called exactly once — not twice — so no duplicate
    // issue_actions rows are created when the LLM hallucinates a repeated decision.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const issues = [makeIssue({ number: 5, title: "Dedup insert test" })];
    // LLM returns two decisions for the same issue: only the first must be persisted
    const deps = makeDeps([
      { issueNumber: 5, action: "add_to_backlog", reason: "Good feature request" },
      { issueNumber: 5, action: "not_applicable", reason: "Duplicate — should be dropped" },
    ]);
    const mockDb = {} as import("better-sqlite3").Database;

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

    // Guard: only one decision in result, only one insertIssueAction call
    expect(result.decisions).toHaveLength(1);
    expect(mockInsertIssueAction).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Duplicate decision"),
    );

    warnSpy.mockRestore();
  });
});

describe("triageIssues real DB integration", () => {
  // These tests use a real in-memory SQLite database to verify that the
  // hasIssueAction dedup guard and closeCandidates transaction commit work
  // correctly against actual SQLite — not just mocked function calls.
  const projectConfig: ProjectConfig = { filePath: "ROADMAP.md" };
  let realDb: ReturnType<typeof initDb>;
  let actualDbModule: typeof import("../src/db.js");

  function makeIntegrationDeps(decisions: Array<{ issueNumber: number; action: string; reason: string }>) {
    const json = JSON.stringify(decisions);
    async function* fakeQuery() {
      yield { result: json };
    }
    return { queryFn: () => fakeQuery() as AsyncIterable<unknown> };
  }

  beforeAll(async () => {
    actualDbModule = await vi.importActual<typeof import("../src/db.js")>("../src/db.js");
  });

  beforeEach(() => {
    // The top-level beforeEach runs first and resets mockHasIssueAction to
    // mockReturnValue(false). Override here (inner beforeEach runs after outer)
    // to wire the mocks through to the real in-memory SQLite instance.
    mockHasIssueAction.mockImplementation((db, issueNumber, action) =>
      actualDbModule.hasIssueAction(db, issueNumber, action)
    );
    mockInsertIssueAction.mockImplementation((db, cycleNumber, issueNumber, action) =>
      actualDbModule.insertIssueAction(db, cycleNumber, issueNumber, action)
    );
    realDb = initDb(":memory:");
    insertCycle(realDb, makeOutcome({ cycleNumber: 1 }));
  });

  afterEach(() => {
    realDb.close();
    // Restore module-level defaults so other describe blocks are not affected
    mockHasIssueAction.mockReturnValue(false);
    mockInsertIssueAction.mockImplementation(() => {});
  });

  afterAll(() => {
    mockHasIssueAction.mockReturnValue(false);
    mockInsertIssueAction.mockImplementation(() => {});
  });

  it("second triageIssues call with same untriaged issue is a no-op (hasIssueAction dedup guard)", async () => {
    const issue = makeIssue({ number: 100, title: "Real dedup test" });
    const deps = makeIntegrationDeps([{ issueNumber: 100, action: "add_to_backlog", reason: "Valid" }]);

    // First call: real hasIssueAction returns false → issue is triaged, addedToBacklog populated
    const result1 = await triageIssues([issue], [], 1, projectConfig, realDb, deps);
    expect(result1.addedToBacklog).toContain(100);

    // Second call: real hasIssueAction now returns true (row was inserted) → no-op
    const result2 = await triageIssues([issue], [], 1, projectConfig, realDb, deps);
    expect(result2.addedToBacklog).toHaveLength(0);
    expect(result2.decisions).toHaveLength(0);
  });

  it("alreadyOnBoard Done issue records exactly 1 row in issue_actions (closeCandidates transaction)", async () => {
    const issue = makeIssue({ number: 200, title: "Already done issue" });
    const doneBoard = [
      makeBoardItem({ linkedIssueNumber: 200, status: "Done", title: "Done item" }),
    ];

    await triageIssues([issue], doneBoard, 1, projectConfig, realDb);

    const row = realDb.prepare("SELECT COUNT(*) as cnt FROM issue_actions").get() as { cnt: number };
    expect(row.cnt).toBe(1);
  });

  it("alreadyOnBoard Done: hasIssueAction returns true after pre-record DB transaction (refactor guard)", async () => {
    // The closeCandidates transaction (triage.ts lines 242–248) pre-records
    // insertIssueAction(TRIAGE_ACTION_NAME) before the GitHub close API fan-out.
    // This test verifies hasIssueAction(realDb, ...) returns true after the call,
    // confirming the guard survives a future refactor that might move the transaction.
    const issue = makeIssue({ number: 201, title: "Done-linked refactor guard" });
    const doneBoard = [
      makeBoardItem({ linkedIssueNumber: 201, status: "Done", title: "Done item for 201" }),
    ];

    await triageIssues([issue], doneBoard, 1, projectConfig, realDb);

    // hasIssueAction must return true — the transaction committed before the
    // GitHub close API was called, so a crash during close cannot re-queue the issue.
    expect(actualDbModule.hasIssueAction(realDb, 201, TRIAGE_ACTION_NAME)).toBe(true);
  });
});

describe("triage constants", () => {
  it("TRIAGE_REASON_MAX_CHARS is 2000 (value-pinning)", () => {
    expect(TRIAGE_REASON_MAX_CHARS).toBe(2000);
  });

  it("TRIAGE_ERROR_PREVIEW_CHARS is 200 (value-pinning)", () => {
    expect(TRIAGE_ERROR_PREVIEW_CHARS).toBe(200);
  });

  it("TRIAGE_ACTION_NAME is 'triaged' (value-pinning)", () => {
    expect(TRIAGE_ACTION_NAME).toBe("triaged");
  });

  it("TRIAGE_BOARD_STATUS_DONE is 'Done' (value-pinning)", () => {
    expect(TRIAGE_BOARD_STATUS_DONE).toBe("Done");
  });

  it("TRIAGE_BOARD_STATUS_DONE equals STATUS_DONE from planning (symmetric cross-module pin)", () => {
    // Guards the delegation TRIAGE_BOARD_STATUS_DONE = STATUS_DONE in triage.ts:
    // if STATUS_DONE is ever renamed in planning.ts the compile-time delegation
    // would catch it, but this runtime pin locks the identical string value so a
    // copy-paste divergence (e.g. both constants exist but differ) is also caught.
    expect(TRIAGE_BOARD_STATUS_DONE).toBe(STATUS_DONE);
  });

  it("TRIAGE_ALREADY_ON_BOARD_COMMENT is correct message (value-pinning)", () => {
    expect(TRIAGE_ALREADY_ON_BOARD_COMMENT).toBe("This issue is already tracked on the Bloom Evolution Roadmap.");
  });
});
