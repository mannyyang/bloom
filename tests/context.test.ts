import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";

// Mock all external dependencies
vi.mock("fs", () => ({
  readFileSync: vi.fn(),
}));

vi.mock("../src/db.js", () => ({
  getRecentJournalSummary: vi.fn(),
  getCycleStats: vi.fn(),
  formatCycleStats: vi.fn(),
}));

vi.mock("../src/issues.js", () => ({
  fetchCommunityIssues: vi.fn(),
}));

vi.mock("../src/triage.js", () => ({
  triageIssues: vi.fn(),
}));

vi.mock("../src/memory.js", () => ({
  formatMemoryForPrompt: vi.fn(),
}));

vi.mock("../src/planning.js", () => ({
  ensureProject: vi.fn(),
  getProjectItems: vi.fn(),
  pickNextItem: vi.fn(),
  updateItemStatus: vi.fn(),
  demoteStaleInProgressItems: vi.fn().mockReturnValue([]),
  formatPlanningContext: vi.fn(),
}));

vi.mock("../src/errors.js", () => ({
  errorMessage: vi.fn((err: unknown) => String(err)),
}));

import { readFileSync } from "fs";
import { getRecentJournalSummary, getCycleStats, formatCycleStats } from "../src/db.js";
import { fetchCommunityIssues } from "../src/issues.js";
import { triageIssues } from "../src/triage.js";
import { formatMemoryForPrompt } from "../src/memory.js";
import {
  ensureProject,
  getProjectItems,
  pickNextItem,
  updateItemStatus,
  demoteStaleInProgressItems,
  formatPlanningContext,
} from "../src/planning.js";
import { loadEvolutionContext } from "../src/context.js";

// Fake db object — all DB calls are mocked
const fakeDb = {} as Database.Database;

function setupDefaults() {
  vi.mocked(readFileSync).mockReturnValue("# Identity");
  vi.mocked(getRecentJournalSummary).mockReturnValue("journal summary");
  vi.mocked(fetchCommunityIssues).mockResolvedValue([]);
  vi.mocked(getCycleStats).mockReturnValue({} as ReturnType<typeof getCycleStats>);
  vi.mocked(formatCycleStats).mockReturnValue("stats text");
  vi.mocked(formatMemoryForPrompt).mockReturnValue("memory context");
  vi.mocked(ensureProject).mockReturnValue(null);
  vi.mocked(demoteStaleInProgressItems).mockReturnValue([]);
}

describe("loadEvolutionContext", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDefaults();
  });

  it("returns identity from IDENTITY.md", async () => {
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(readFileSync).toHaveBeenCalledWith("IDENTITY.md", "utf-8");
    expect(ctx.identity).toBe("# Identity");
  });

  it("returns journal summary from DB", async () => {
    vi.mocked(getRecentJournalSummary).mockReturnValue("recent journal");
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(ctx.journalSummary).toBe("recent journal");
  });

  it("returns empty string when journal summary is null", async () => {
    vi.mocked(getRecentJournalSummary).mockReturnValue(null as unknown as string);
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(ctx.journalSummary).toBe("");
  });

  it("fetches community issues", async () => {
    const issues = [
      { number: 1, title: "Bug", body: "", reactions: 5, labels: [] },
      { number: 2, title: "Feature", body: "", reactions: 2, labels: [] },
    ];
    vi.mocked(fetchCommunityIssues).mockResolvedValue(issues);
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(ctx.issues).toEqual(issues);
  });

  it("returns cycle stats text", async () => {
    vi.mocked(formatCycleStats).mockReturnValue("my stats");
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(ctx.cycleStatsText).toBe("my stats");
  });

  it("returns empty string when formatCycleStats returns empty", async () => {
    vi.mocked(formatCycleStats).mockReturnValue("");
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(ctx.cycleStatsText).toBe("");
  });

  it("returns memory context from formatMemoryForPrompt", async () => {
    vi.mocked(formatMemoryForPrompt).mockReturnValue("learnings here");
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(formatMemoryForPrompt).toHaveBeenCalledWith(fakeDb, 2000);
    expect(ctx.memoryContext).toBe("learnings here");
  });

  it("returns null projectConfig and currentItem when ensureProject returns null", async () => {
    vi.mocked(ensureProject).mockReturnValue(null);
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(ctx.projectConfig).toBeNull();
    expect(ctx.currentItem).toBeNull();
    expect(ctx.planningContext).toBe("");
  });

  it("loads planning context when roadmap exists", async () => {
    const config = { filePath: "ROADMAP.md" };
    const items = [
      { id: "1", title: "Item 1", status: "Up Next", body: "", linkedIssueNumber: null, reactions: 0 },
    ];
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue(items);
    vi.mocked(pickNextItem).mockReturnValue(items[0]);
    vi.mocked(formatPlanningContext).mockReturnValue("planning output");

    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(ctx.projectConfig).toEqual(config);
    expect(ctx.currentItem).toEqual(items[0]);
    expect(ctx.planningContext).toBe("planning output");
  });

  it("marks selected item as In Progress", async () => {
    const config = { filePath: "ROADMAP.md" };
    const item = { id: "42", title: "Do thing", status: "Up Next", body: "", linkedIssueNumber: null, reactions: 0 };
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue([item]);
    vi.mocked(pickNextItem).mockReturnValue(item);
    vi.mocked(updateItemStatus).mockReturnValue(true);
    vi.mocked(formatPlanningContext).mockReturnValue("");

    const consoleSpy = vi.spyOn(console, "log");
    await loadEvolutionContext(fakeDb, 1);
    expect(updateItemStatus).toHaveBeenCalledWith(config, "42", "In Progress", undefined, 1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("marked In Progress"));
  });

  it("logs error when updateItemStatus returns false for In Progress mark", async () => {
    const config = { filePath: "ROADMAP.md" };
    const item = { id: "99", title: "Missing item", status: "Up Next", body: "", linkedIssueNumber: null, reactions: 0 };
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue([item]);
    vi.mocked(pickNextItem).mockReturnValue(item);
    vi.mocked(updateItemStatus).mockReturnValue(false);
    vi.mocked(formatPlanningContext).mockReturnValue("");

    const consoleSpy = vi.spyOn(console, "error");
    await loadEvolutionContext(fakeDb, 1);
    expect(updateItemStatus).toHaveBeenCalledWith(config, "99", "In Progress", undefined, 1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Could not mark"));
  });

  it("does not mark In Progress when pickNextItem returns null", async () => {
    const config = { filePath: "ROADMAP.md" };
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue([]);
    vi.mocked(pickNextItem).mockReturnValue(null);
    vi.mocked(formatPlanningContext).mockReturnValue("");

    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(updateItemStatus).not.toHaveBeenCalled();
    expect(ctx.currentItem).toBeNull();
  });

  it("triages issues when roadmap and issues both exist", async () => {
    const config = { filePath: "ROADMAP.md" };
    const items = [
      { id: "1", title: "Item", status: "Up Next", body: "", linkedIssueNumber: null, reactions: 0 },
    ];
    const issues = [{ number: 10, title: "Bug", body: "", reactions: 3, labels: [] }];
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue(items);
    vi.mocked(fetchCommunityIssues).mockResolvedValue(issues);
    vi.mocked(triageIssues).mockResolvedValue({
      decisions: [],
      addedToBacklog: [],
      closed: [],
    });
    vi.mocked(pickNextItem).mockReturnValue(null);
    vi.mocked(formatPlanningContext).mockReturnValue("");

    await loadEvolutionContext(fakeDb, 1);
    expect(triageIssues).toHaveBeenCalledWith(issues, items, 1, config, fakeDb);
  });

  it("re-fetches project items after triage adds new ones", async () => {
    const config = { filePath: "ROADMAP.md" };
    const itemsBefore = [
      { id: "1", title: "Old", status: "Up Next", body: "", linkedIssueNumber: null, reactions: 0 },
    ];
    const itemsAfter = [
      ...itemsBefore,
      { id: "2", title: "New from triage", status: "Backlog", body: "", linkedIssueNumber: 10, reactions: 3 },
    ];
    const issues = [{ number: 10, title: "Bug", body: "", reactions: 3, labels: [] }];

    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems)
      .mockReturnValueOnce(itemsBefore)
      .mockReturnValueOnce(itemsAfter);
    vi.mocked(fetchCommunityIssues).mockResolvedValue(issues);
    vi.mocked(triageIssues).mockResolvedValue({
      decisions: [{ issueNumber: 10, action: "add_to_backlog", reason: "New issue" }],
      addedToBacklog: [10],
      closed: [],
    });
    vi.mocked(pickNextItem).mockReturnValue(null);
    vi.mocked(formatPlanningContext).mockReturnValue("");

    await loadEvolutionContext(fakeDb, 1);

    // getProjectItems should be called twice: before and after triage
    expect(getProjectItems).toHaveBeenCalledTimes(2);
    // formatPlanningContext should receive the post-triage items
    expect(formatPlanningContext).toHaveBeenCalledWith(itemsAfter, null);
  });

  it("skips triage when no issues exist", async () => {
    const config = { filePath: "ROADMAP.md" };
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue([]);
    vi.mocked(fetchCommunityIssues).mockResolvedValue([]);
    vi.mocked(pickNextItem).mockReturnValue(null);
    vi.mocked(formatPlanningContext).mockReturnValue("");

    await loadEvolutionContext(fakeDb, 1);
    expect(triageIssues).not.toHaveBeenCalled();
  });

  it("handles planning errors gracefully (non-fatal)", async () => {
    vi.mocked(ensureProject).mockImplementation(() => {
      throw new Error("roadmap parse failed");
    });

    const ctx = await loadEvolutionContext(fakeDb, 1);
    // Should not throw, should return empty planning context
    expect(ctx.projectConfig).toBeNull();
    expect(ctx.currentItem).toBeNull();
    expect(ctx.planningContext).toBe("");
    // Other fields should still be populated
    expect(ctx.identity).toBe("# Identity");
  });

  it("handles triage errors gracefully within planning try-catch", async () => {
    const config = { filePath: "ROADMAP.md" };
    const issues = [{ number: 1, title: "Bug", body: "", reactions: 0, labels: [] }];
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue([]);
    vi.mocked(fetchCommunityIssues).mockResolvedValue(issues);
    vi.mocked(triageIssues).mockRejectedValue(new Error("triage failed"));

    const ctx = await loadEvolutionContext(fakeDb, 1);
    // Planning should fail gracefully; projectConfig stays null because error was caught
    expect(ctx.planningContext).toBe("");
  });

  it("passes cycle count to triage", async () => {
    const config = { filePath: "ROADMAP.md" };
    const issues = [{ number: 5, title: "Request", body: "", reactions: 1, labels: [] }];
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue([]);
    vi.mocked(fetchCommunityIssues).mockResolvedValue(issues);
    vi.mocked(triageIssues).mockResolvedValue({
      decisions: [],
      addedToBacklog: [],
      closed: [],
    });
    vi.mocked(pickNextItem).mockReturnValue(null);
    vi.mocked(formatPlanningContext).mockReturnValue("");

    await loadEvolutionContext(fakeDb, 42);
    expect(triageIssues).toHaveBeenCalledWith(issues, [], 42, config, fakeDb);
  });

  it("logs closed issue numbers when triage closes issues", async () => {
    const config = { filePath: "ROADMAP.md" };
    const issues = [
      { number: 5, title: "Old Bug", body: "", reactions: 0, labels: [] },
      { number: 6, title: "Stale Request", body: "", reactions: 0, labels: [] },
    ];
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue([]);
    vi.mocked(fetchCommunityIssues).mockResolvedValue(issues);
    vi.mocked(triageIssues).mockResolvedValue({
      decisions: [],
      addedToBacklog: [],
      closed: [5, 6],
    });
    vi.mocked(pickNextItem).mockReturnValue(null);
    vi.mocked(formatPlanningContext).mockReturnValue("");

    const consoleSpy = vi.spyOn(console, "log");
    await loadEvolutionContext(fakeDb, 1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Closed: #5, #6"));
  });

  it("logs reaction count for roadmap items with reactions > 0", async () => {
    const config = { filePath: "ROADMAP.md" };
    const items = [
      { id: "1", title: "Popular Item", status: "Up Next", body: "", linkedIssueNumber: null, reactions: 5 },
    ];
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue(items);
    vi.mocked(fetchCommunityIssues).mockResolvedValue([]);
    vi.mocked(pickNextItem).mockReturnValue(null);
    vi.mocked(formatPlanningContext).mockReturnValue("");

    const consoleSpy = vi.spyOn(console, "log");
    await loadEvolutionContext(fakeDb, 1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("(5 reactions)"));
  });
});
