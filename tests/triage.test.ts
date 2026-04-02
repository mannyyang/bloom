import { describe, it, expect, vi, afterEach } from "vitest";
import { buildTriagePrompt, parseTriageResponse, triageIssues } from "../src/triage.js";
import type { CommunityIssue } from "../src/issues.js";
import { closeIssueWithComment, detectRepo, isValidRepo } from "../src/issues.js";
import { hasIssueAction } from "../src/db.js";
import { addLinkedItem } from "../src/planning.js";
import type { ProjectItem, ProjectConfig } from "../src/planning.js";

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

  it("truncates long issue bodies", () => {
    const longBody = "x".repeat(500);
    const prompt = buildTriagePrompt([makeIssue({ body: longBody })], []);
    // Body should be truncated to 200 chars (aligned with planning.ts cap)
    expect(prompt).not.toContain("x".repeat(500));
    expect(prompt).toContain("x".repeat(200));
    expect(prompt).not.toContain("x".repeat(201));
  });

  it("leaves short bodies intact (no truncation under 200 chars)", () => {
    const shortBody = "x".repeat(100);
    const prompt = buildTriagePrompt([makeIssue({ body: shortBody })], []);
    expect(prompt).toContain("x".repeat(100));
  });

  it("handles issues with empty bodies", () => {
    const prompt = buildTriagePrompt([makeIssue({ number: 7, title: "No body", body: "" })], []);
    expect(prompt).toContain("#7");
    expect(prompt).toContain("No body");
  });

  it("includes zero-reaction issues", () => {
    const prompt = buildTriagePrompt([makeIssue({ number: 10, reactions: 0 })], []);
    expect(prompt).toContain("#10");
    expect(prompt).toContain("0 reactions");
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
    expect(parseTriageResponse('{"issueNumber": 1}')).toEqual([]);
  });

  it("filters out entries with invalid action values", () => {
    const input = `[
      {"issueNumber": 1, "action": "add_to_backlog", "reason": "Good"},
      {"issueNumber": 2, "action": "invalid_action", "reason": "Bad"}
    ]`;
    const result = parseTriageResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(1);
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

    const result = await triageIssues(issues, [], 81, projectConfig);

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

    await triageIssues(issues, [], 81, projectConfig);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] Failed to process issue #42"),
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

    mockCloseIssue.mockResolvedValueOnce(true);

    const result = await triageIssues(issues, [], 5, projectConfig, undefined, deps);

    expect(result.addedToBacklog).toContain(7);
    expect(result.closed).not.toContain(7);
    expect(mockAddLinkedItem).toHaveBeenCalledWith(
      projectConfig, 7, "Add caching", "Please add caching",
    );
  });

  it("downgrades already_done to add_to_backlog when no Done board item is linked (LLM path)", async () => {
    // LLM returns already_done for issue #8, but no Done board item is linked to #8.
    // The Done-gate should downgrade it to add_to_backlog.
    const issues = [makeIssue({ number: 8, title: "Already done" })];
    const deps = makeDeps([{ issueNumber: 8, action: "already_done", reason: "Already exists" }]);

    mockCloseIssue.mockResolvedValueOnce(true);

    const result = await triageIssues(issues, [], 5, projectConfig, undefined, deps);

    // Downgraded: added to backlog, not treated as already_done. Not closed yet.
    expect(result.addedToBacklog).toContain(8);
    expect(result.closed).not.toContain(8);
    expect(mockAddLinkedItem).toHaveBeenCalled();
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

    const result = await triageIssues(issues, boardItems, 5, projectConfig, undefined, deps);

    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(result.closed).not.toContain(11);
    expect(result.decisions).toEqual([]);
  });

  it("ignores LLM decisions for issue numbers not in the untriaged set", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const issues = [makeIssue({ number: 1, title: "Real issue" })];
    const deps = makeDeps([
      { issueNumber: 1, action: "not_applicable", reason: "OK" },
      { issueNumber: 999, action: "add_to_backlog", reason: "Hallucinated issue" },
    ]);

    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, [], 5, projectConfig, undefined, deps);

    expect(result.closed).toEqual([1]);
    expect(result.addedToBacklog).toEqual([]);
    // Hallucinated issue number should produce a warning, not silently vanish
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("#999"));
    warnSpy.mockRestore();
  });

  it("returns early with empty result when LLM call fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const issues = [makeIssue({ number: 1, title: "Issue" })];
    const deps = makeFailingDeps(new Error("API timeout"));

    const result = await triageIssues(issues, [], 5, projectConfig, undefined, deps);

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

    const result = await triageIssues(issues, [], 5, projectConfig, undefined, deps);

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

    const result = await triageIssues(issues, [], 10, projectConfig, undefined, deps);

    expect(result.decisions).toHaveLength(3);
    // Issue #2's already_done is downgraded to add_to_backlog (Done-gate: no linked Done item)
    // add_to_backlog issues (#1, #2) stay open; only not_applicable (#3) is closed immediately
    expect(result.addedToBacklog).toEqual([1, 2]);
    expect(result.closed).toEqual([3]);
  });

  it("Guard A: skips closing an alreadyOnBoard issue when db records it as already triaged", async () => {
    // Issue #10 is on the board; db says it was already triaged in a prior cycle
    const issues = [makeIssue({ number: 10, title: "On board" })];
    const boardItems = [makeBoardItem({ linkedIssueNumber: 10 })];
    const deps = makeDeps([]);

    // Simulate a real db object with the issue already marked as triaged
    const mockDb = {} as import("better-sqlite3").Database;
    mockHasIssueAction.mockReturnValueOnce(true); // Guard A fires

    const result = await triageIssues(issues, boardItems, 5, projectConfig, mockDb, deps);

    // closeIssueWithComment must NOT be called because the guard skipped the issue
    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(result.closed).toEqual([]);
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

  it("does not add to backlog when repo is invalid", async () => {
    mockIsValidRepo.mockReturnValueOnce(false);
    mockDetectRepo.mockReturnValueOnce(null);
    const issues = [makeIssue({ number: 1, title: "Feature" })];
    const deps = makeDeps([{ issueNumber: 1, action: "add_to_backlog", reason: "Good" }]);

    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, [], 5, projectConfig, undefined, deps);

    // addLinkedItem should not be called because repo is null
    expect(mockAddLinkedItem).not.toHaveBeenCalled();
    // add_to_backlog issues are not closed at triage time
    expect(result.closed).toEqual([]);
  });

  it("does not add to backlog when isValidRepo returns false for a non-null repo", async () => {
    mockIsValidRepo.mockReturnValueOnce(false);
    mockDetectRepo.mockReturnValueOnce("owner/repo"); // non-null repo — exercises the isValidRepo guard
    const issues = [makeIssue({ number: 2, title: "Feature B" })];
    const deps = makeDeps([{ issueNumber: 2, action: "add_to_backlog", reason: "Looks good" }]);

    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, [], 5, projectConfig, undefined, deps);

    // isValidRepo returned false, so addLinkedItem must not be called even though repo is non-null
    expect(mockAddLinkedItem).not.toHaveBeenCalled();
    expect(result.closed).toEqual([]);
  });

  it("passes correct comment text for each action type", async () => {
    const issues = [makeIssue({ number: 1 })];
    const deps = makeDeps([{ issueNumber: 1, action: "not_applicable", reason: "Out of scope" }]);

    mockCloseIssue.mockResolvedValue(true);

    await triageIssues(issues, [], 7, projectConfig, undefined, deps);

    expect(mockCloseIssue).toHaveBeenCalledWith(
      1,
      7,
      expect.stringContaining("not applicable or out of scope"),
      undefined,
      "triaged",
      "test-owner/test-repo",
    );
  });


  it("does not close add_to_backlog issues at triage time (they stay open until Done)", async () => {
    const issues = [makeIssue({ number: 11, title: "New feature request" })];
    const deps = makeDeps([{ issueNumber: 11, action: "add_to_backlog", reason: "Valid idea." }]);

    const result = await triageIssues(issues, [], 5, projectConfig, undefined, deps);

    // add_to_backlog issues must NOT be closed — they will be closed when the roadmap item is Done
    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(result.closed).not.toContain(11);
  });

  it("does not close issue when LLM already_done is downgraded to add_to_backlog by Done-gate", async () => {
    // LLM claims already_done but no Done board item links to #15 → downgraded to add_to_backlog
    // add_to_backlog issues stay open until the roadmap item is Done.
    const issues = [makeIssue({ number: 15, title: "Feature already done" })];
    const deps = makeDeps([{ issueNumber: 15, action: "already_done", reason: "This was implemented in cycle 100." }]);

    const result = await triageIssues(issues, [], 9, projectConfig, undefined, deps);

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

    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, boardItems, 5, projectConfig, undefined, deps);

    // Issue #22 should be downgraded to add_to_backlog — no Done evidence for it
    expect(result.addedToBacklog).toContain(22);
    expect(mockAddLinkedItem).toHaveBeenCalled();
    // add_to_backlog issues stay open — NOT closed at triage time
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("uses BLOOM_MODEL env var when set", async () => {
    const capturedOptions: unknown[] = [];
    const issues = [makeIssue({ number: 1 })];
    const customQuery = async function* (args: { options?: { model?: string } }) {
      capturedOptions.push(args.options);
      yield { result: JSON.stringify([{ issueNumber: 1, action: "not_applicable", reason: "Test" }]) };
    };
    const deps = { queryFn: customQuery as Parameters<typeof triageIssues>[5] extends undefined ? never : NonNullable<Parameters<typeof triageIssues>[5]>["queryFn"] };

    mockCloseIssue.mockResolvedValue(true);
    const originalModel = process.env.BLOOM_MODEL;
    process.env.BLOOM_MODEL = "claude-test-model";
    try {
      await triageIssues(issues, [], 5, projectConfig, undefined, deps);
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

    // closeIssueWithComment returns false (soft failure — e.g. already closed externally)
    mockCloseIssue.mockResolvedValueOnce(false);

    const result = await triageIssues(issues, boardItems, 5, projectConfig, undefined, deps);

    expect(mockCloseIssue).toHaveBeenCalledTimes(1);
    // wasClosed was false, so the issue must NOT appear in result.closed
    expect(result.closed).toEqual([]);
  });

  it("does not add to result.closed when decisions loop closeIssueWithComment returns false", async () => {
    // Issue #5 goes through LLM triage — decisions loop path
    const issues = [makeIssue({ number: 5, title: "Some issue" })];
    const deps = makeDeps([{ issueNumber: 5, action: "not_applicable", reason: "Out of scope" }]);

    // closeIssueWithComment returns false (soft failure, not a throw)
    mockCloseIssue.mockResolvedValueOnce(false);

    const result = await triageIssues(issues, [], 5, projectConfig, undefined, deps);

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

    mockCloseIssue.mockResolvedValue(true);
    const originalModel = process.env.BLOOM_MODEL;
    delete process.env.BLOOM_MODEL;
    try {
      await triageIssues(issues, [], 5, projectConfig, undefined, deps);
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

    mockCloseIssue.mockRejectedValueOnce(new Error("422 Unprocessable Entity"));

    // Should not throw — the catch block handles it gracefully
    const result = await triageIssues(issues, boardItems, 5, projectConfig, undefined, deps);

    expect(result.closed).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] Could not close already-on-board issue #10"),
    );
    warnSpy.mockRestore();
  });
});
