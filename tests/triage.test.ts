import { describe, it, expect } from "vitest";
import { buildTriagePrompt, parseTriageResponse } from "../src/triage.js";
import type { CommunityIssue } from "../src/issues.js";
import type { ProjectItem } from "../src/planning.js";

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
    fieldValueId: null,
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
    // Body should be truncated to 300 chars
    expect(prompt).not.toContain("x".repeat(500));
    expect(prompt).toContain("x".repeat(300));
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
    expect(parseTriageResponse("not json at all")).toEqual([]);
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
});
