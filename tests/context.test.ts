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
  syncReactionsToItems: vi.fn().mockImplementation((items: unknown[]) => Promise.resolve(items)),
}));

vi.mock("../src/triage.js", () => ({
  triageIssues: vi.fn(),
}));

vi.mock("../src/memory.js", () => ({
  formatMemoryForPrompt: vi.fn(),
  MAX_MEMORY_CHARS: 1200,
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
import { fetchCommunityIssues, syncReactionsToItems } from "../src/issues.js";
import { triageIssues } from "../src/triage.js";
import { formatMemoryForPrompt } from "../src/memory.js";
import {
  ensureProject,
  getProjectItems,
  pickNextItem,
  updateItemStatus,
  demoteStaleInProgressItems,
  formatPlanningContext,
  type ProjectItem,
} from "../src/planning.js";
import { loadEvolutionContext, CONTEXT_JOURNAL_MAX_CHARS, CONTEXT_JOURNAL_MAX_CYCLES } from "../src/context.js";
import { MAX_MEMORY_CHARS } from "../src/memory.js";

// Fake db object — all DB calls are mocked
const fakeDb = {} as Database.Database;

describe("context constants", () => {
  it("CONTEXT_JOURNAL_MAX_CHARS is 1200 (value-pinning)", () => {
    expect(CONTEXT_JOURNAL_MAX_CHARS).toBe(1200);
  });

  it("MAX_MEMORY_CHARS is 1200 (value-pinning)", () => {
    expect(MAX_MEMORY_CHARS).toBe(1200);
  });

  it("CONTEXT_JOURNAL_MAX_CYCLES is 2 (value-pinning)", () => {
    expect(CONTEXT_JOURNAL_MAX_CYCLES).toBe(2);
  });
});

function setupDefaults() {
  vi.mocked(readFileSync).mockReturnValue("# Identity");
  vi.mocked(getRecentJournalSummary).mockReturnValue("journal summary");
  vi.mocked(fetchCommunityIssues).mockResolvedValue([]);
  vi.mocked(syncReactionsToItems).mockImplementation((items) => Promise.resolve(items));
  vi.mocked(getCycleStats).mockReturnValue({} as ReturnType<typeof getCycleStats>);
  vi.mocked(formatCycleStats).mockReturnValue("stats text");
  vi.mocked(formatMemoryForPrompt).mockReturnValue("memory context");
  vi.mocked(ensureProject).mockImplementation(() => { throw new Error("no roadmap"); });
  vi.mocked(demoteStaleInProgressItems).mockReturnValue([]);
}

describe("loadEvolutionContext", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDefaults();
  });

  it("throws a descriptive error when IDENTITY.md is missing", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    await expect(loadEvolutionContext(fakeDb, 1)).rejects.toThrow(
      "IDENTITY.md missing — cannot start cycle",
    );
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

  it("calls getRecentJournalSummary with (db, CONTEXT_JOURNAL_MAX_CHARS, CONTEXT_JOURNAL_MAX_CYCLES)", async () => {
    // Tripwire: catches silent argument drift without relying on output side-effects.
    await loadEvolutionContext(fakeDb, 1);
    expect(getRecentJournalSummary).toHaveBeenCalledWith(
      fakeDb,
      CONTEXT_JOURNAL_MAX_CHARS,
      CONTEXT_JOURNAL_MAX_CYCLES,
    );
  });

  it("fetches community issues", async () => {
    const issues = [
      { number: 1, title: "Bug", body: "", reactions: 5, labels: [] },
      { number: 2, title: "Feature", body: "", reactions: 2, labels: [] },
    ];
    vi.mocked(fetchCommunityIssues).mockResolvedValue(issues);
    const consoleSpy = vi.spyOn(console, "log");
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(ctx.issues).toEqual(issues);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Community issues: 2 open"));
  });

  it("returns empty issues array when fetchCommunityIssues rejects", async () => {
    vi.mocked(fetchCommunityIssues).mockRejectedValue(new Error("network timeout"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(ctx.issues).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[context] Failed to fetch community issues (non-fatal)"),
    );
    errorSpy.mockRestore();
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
    expect(formatMemoryForPrompt).toHaveBeenCalledWith(fakeDb, 1200);
    expect(ctx.memoryContext).toBe("learnings here");
  });

  it("returns null projectConfig and currentItem when ensureProject throws", async () => {
    vi.mocked(ensureProject).mockImplementation(() => { throw new Error("no roadmap"); });
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(ctx.projectConfig).toBeNull();
    expect(ctx.currentItem).toBeNull();
    expect(ctx.planningContext).toBe("");
  });

  it("loads planning context when roadmap exists", async () => {
    const config = { filePath: "ROADMAP.md" };
    const items: ProjectItem[] = [
      { id: "1", title: "Item 1", status: "Up Next", body: "", linkedIssueNumber: null, reactions: 0 },
    ];
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue(items);
    vi.mocked(pickNextItem).mockReturnValue(items[0]);
    vi.mocked(formatPlanningContext).mockReturnValue("planning output");

    const consoleSpy = vi.spyOn(console, "log");
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(ctx.projectConfig).toEqual(config);
    expect(ctx.currentItem).toEqual(items[0]);
    expect(ctx.planningContext).toBe("planning output");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("1 items on roadmap"));
  });

  it("marks selected item as In Progress", async () => {
    const config = { filePath: "ROADMAP.md" };
    const item: ProjectItem = { id: "42", title: "Do thing", status: "Up Next", body: "", linkedIssueNumber: null, reactions: 0 };
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
    const item: ProjectItem = { id: "99", title: "Missing item", status: "Up Next", body: "", linkedIssueNumber: null, reactions: 0 };
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

    const consoleSpy = vi.spyOn(console, "log");
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(updateItemStatus).not.toHaveBeenCalled();
    expect(ctx.currentItem).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No actionable items found"));
  });

  it("triages issues when roadmap and issues both exist", async () => {
    const config = { filePath: "ROADMAP.md" };
    const items: ProjectItem[] = [
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
    const itemsBefore: ProjectItem[] = [
      { id: "1", title: "Old", status: "Up Next", body: "", linkedIssueNumber: null, reactions: 0 },
    ];
    const itemsAfter: ProjectItem[] = [
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

    const consoleSpy = vi.spyOn(console, "log");
    await loadEvolutionContext(fakeDb, 1);

    // getProjectItems should be called twice: before and after triage
    expect(getProjectItems).toHaveBeenCalledTimes(2);
    // formatPlanningContext should receive the post-triage items
    expect(formatPlanningContext).toHaveBeenCalledWith(itemsAfter, null);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("2 items on roadmap (post-triage)"));
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

    const errorSpy = vi.spyOn(console, "error");
    const ctx = await loadEvolutionContext(fakeDb, 1);
    // Should not throw, should return empty planning context
    expect(ctx.projectConfig).toBeNull();
    expect(ctx.currentItem).toBeNull();
    expect(ctx.planningContext).toBe("");
    // Other fields should still be populated
    expect(ctx.identity).toBe("# Identity");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed (non-fatal)"));
  });

  it("handles getProjectItems throwing gracefully (non-fatal)", async () => {
    const config = { filePath: "ROADMAP.md" };
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockImplementation(() => {
      throw new Error("file read error");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(ctx.planningContext).toBe("");
    expect(ctx.currentItem).toBeNull();
    expect(ctx.identity).toBe("# Identity");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[planning] Failed (non-fatal)"));
    errorSpy.mockRestore();
  });

  it("handles demoteStaleInProgressItems throwing gracefully (non-fatal)", async () => {
    const config = { filePath: "ROADMAP.md" };
    const items: ProjectItem[] = [
      { id: "1", title: "Item", status: "Up Next", body: "", linkedIssueNumber: null, reactions: 0 },
    ];
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue(items);
    vi.mocked(demoteStaleInProgressItems).mockImplementation(() => {
      throw new Error("demote failed");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(ctx.planningContext).toBe("");
    expect(ctx.currentItem).toBeNull();
    expect(ctx.identity).toBe("# Identity");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[planning] Failed (non-fatal)"));
    errorSpy.mockRestore();
  });

  it("handles pickNextItem throwing gracefully (non-fatal)", async () => {
    const config = { filePath: "ROADMAP.md" };
    const items: ProjectItem[] = [
      { id: "1", title: "Item", status: "Up Next", body: "", linkedIssueNumber: null, reactions: 0 },
    ];
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue(items);
    vi.mocked(pickNextItem).mockImplementation(() => {
      throw new Error("pick failed");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = await loadEvolutionContext(fakeDb, 1);
    expect(ctx.planningContext).toBe("");
    expect(ctx.currentItem).toBeNull();
    expect(ctx.identity).toBe("# Identity");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[planning] Failed (non-fatal)"));
    errorSpy.mockRestore();
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

  it("logs issue numbers when triage adds items to backlog", async () => {
    const config = { filePath: "ROADMAP.md" };
    const issues = [
      { number: 7, title: "Feature Request", body: "", reactions: 0, labels: [] },
      { number: 8, title: "Enhancement", body: "", reactions: 0, labels: [] },
    ];
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue([]);
    vi.mocked(fetchCommunityIssues).mockResolvedValue(issues);
    vi.mocked(triageIssues).mockResolvedValue({
      decisions: [],
      addedToBacklog: [7, 8],
      closed: [],
    });
    vi.mocked(pickNextItem).mockReturnValue(null);
    vi.mocked(formatPlanningContext).mockReturnValue("");

    const consoleSpy = vi.spyOn(console, "log");
    await loadEvolutionContext(fakeDb, 1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Added to backlog: #7, #8"));
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
    const items: ProjectItem[] = [
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

  it("falls back to original items and logs error when syncReactionsToItems rejects", async () => {
    const config = { filePath: "ROADMAP.md" };
    const items: ProjectItem[] = [
      { id: "1", title: "Item", status: "Up Next", body: "", linkedIssueNumber: null, reactions: 0 },
    ];
    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems).mockReturnValue(items);
    vi.mocked(fetchCommunityIssues).mockResolvedValue([]);
    vi.mocked(syncReactionsToItems).mockRejectedValue(new Error("GitHub API down"));
    vi.mocked(pickNextItem).mockReturnValue(null);
    vi.mocked(formatPlanningContext).mockReturnValue("");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = await loadEvolutionContext(fakeDb, 1);
    // Context should resolve (non-fatal) and still return current item as null
    expect(ctx.currentItem).toBeNull();
    // The error log should mention the sync failure
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[context] Failed to sync reactions (non-fatal)"),
    );
    // formatPlanningContext should have been called with the original items (fallback)
    expect(formatPlanningContext).toHaveBeenCalledWith(items, null);
    errorSpy.mockRestore();
  });

  it("preserves live reaction data on items after demotion-triggered re-fetch", async () => {
    // syncReactionsToItems enriches items with live GitHub counts, but the
    // subsequent getProjectItems call (triggered by demotion) reads from disk
    // where reactions are always 0.  The fix in context.ts builds a reactionMap
    // before the demote call and re-applies it after the re-fetch, so
    // pickNextItem receives enriched items rather than zeroed-out ones.
    const config = { filePath: "ROADMAP.md" };
    const staleItem: ProjectItem = {
      id: "1", title: "Stale Item", status: "In Progress", body: "[since: 1]",
      linkedIssueNumber: null, reactions: 0,
    };
    // Simulate syncReactionsToItems enriching the item with 7 reactions
    const enrichedItem: ProjectItem = { ...staleItem, reactions: 7 };
    // Disk re-read returns reactions=0 (disk never stores live counts)
    const diskItem: ProjectItem = { ...staleItem, status: "Up Next", reactions: 0 };

    vi.mocked(ensureProject).mockReturnValue(config);
    vi.mocked(getProjectItems)
      .mockReturnValueOnce([staleItem])   // initial load
      .mockReturnValueOnce([diskItem]);   // post-demotion re-read from disk
    vi.mocked(fetchCommunityIssues).mockResolvedValue([]);
    // syncReactionsToItems returns enriched item with reactions=7
    vi.mocked(syncReactionsToItems).mockResolvedValue([enrichedItem]);
    vi.mocked(demoteStaleInProgressItems).mockReturnValue(["Stale Item"]);
    vi.mocked(pickNextItem).mockReturnValue(null);
    vi.mocked(formatPlanningContext).mockReturnValue("");

    await loadEvolutionContext(fakeDb, 1);

    // pickNextItem must receive the item with reactions=7 (from the reaction map),
    // not reactions=0 (from the disk re-read), so community signal is preserved.
    expect(pickNextItem).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "1", reactions: 7 })]),
    );
  });

  it("re-reads project items from disk after demotion", async () => {
    // After demoting stale items, context.ts re-reads the roadmap from disk so
    // the in-memory view always matches exactly what demoteStaleInProgressItems
    // wrote, preventing silent divergence if the demotion logic ever changes.
    const config = { filePath: "ROADMAP.md" };
    const staleItem: ProjectItem = {
      id: "1", title: "Stale Item", status: "In Progress", body: "[since: 1]",
      linkedIssueNumber: null, reactions: 0,
    };
    const demotedItem: ProjectItem = {
      id: "1", title: "Stale Item", status: "Up Next", body: "",
      linkedIssueNumber: null, reactions: 0,
    };

    vi.mocked(ensureProject).mockReturnValue(config);
    // First call: initial load; second call: post-demotion re-read
    vi.mocked(getProjectItems)
      .mockReturnValueOnce([staleItem])
      .mockReturnValueOnce([demotedItem]);
    vi.mocked(fetchCommunityIssues).mockResolvedValue([]);
    vi.mocked(demoteStaleInProgressItems).mockReturnValue(["Stale Item"]);
    vi.mocked(pickNextItem).mockReturnValue(null);
    vi.mocked(formatPlanningContext).mockReturnValue("");

    const consoleSpy = vi.spyOn(console, "log");
    await loadEvolutionContext(fakeDb, 1);

    // getProjectItems is called twice: initial load + re-read after demotion
    expect(getProjectItems).toHaveBeenCalledTimes(2);
    // pickNextItem receives the freshly re-read (post-demotion) items, not stale originals
    expect(pickNextItem).toHaveBeenCalledWith([demotedItem]);
    // demotion log message should be emitted
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Demoted 1 stale In Progress item(s) back to Up Next: Stale Item"),
    );
  });
});
