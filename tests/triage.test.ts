import { describe, it, expect, vi, afterEach, afterAll, beforeAll, beforeEach } from "vitest";
import { buildTriagePrompt, parseTriageResponse, triageIssues } from "../src/triage.js";
import type { CommunityIssue } from "../src/issues.js";
import { closeIssueWithComment, detectRepo, isValidRepo } from "../src/issues.js";
import { hasIssueAction, insertIssueAction, initDb, insertCycle } from "../src/db.js";
import { makeOutcome } from "./helpers.js";
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseTriageResponse('{"issueNumber": 1}')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[triage] parseTriageResponse: expected JSON array"),
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
    const mockDb = {} as import("better-sqlite3").Database;

    mockCloseIssue.mockResolvedValue(true);

    const result = await triageIssues(issues, [], 5, projectConfig, mockDb, deps);

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
});
