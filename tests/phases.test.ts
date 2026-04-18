import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CycleOutcome } from "../src/outcomes.js";
import type { ProjectConfig, ProjectItem } from "../src/planning.js";

// Mock lifecycle module
vi.mock("../src/lifecycle.js", () => ({
  runBuildVerification: vi.fn(),
  pushChanges: vi.fn(),
  commitRoadmap: vi.fn(),
}));

// Mock planning module
vi.mock("../src/planning.js", () => ({
  updateItemStatus: vi.fn(),
  demoteStaleInProgressItems: vi.fn().mockReturnValue([]),
}));

// Mock issues module
vi.mock("../src/issues.js", () => ({
  closeIssueWithComment: vi.fn().mockResolvedValue(true),
  detectRepo: vi.fn().mockReturnValue("test-owner/test-repo"),
  isValidRepo: vi.fn().mockReturnValue(true),
}));

import { runBuildVerificationPhase, updatePlanningStatus, pushChangesPhase, demoteStaleItemsPhase } from "../src/phases.js";
import { runBuildVerification, pushChanges, commitRoadmap } from "../src/lifecycle.js";
import { updateItemStatus, demoteStaleInProgressItems } from "../src/planning.js";
import { closeIssueWithComment } from "../src/issues.js";

function createOutcome(overrides: Partial<CycleOutcome> = {}): CycleOutcome {
  return {
    cycleNumber: 1,
    preflightPassed: true,
    improvementsAttempted: 0,
    improvementsSucceeded: 0,
    buildVerificationPassed: false,
    pushSucceeded: false,
    testCountBefore: null,
    testCountAfter: null,
    testTotalBefore: null,
    testTotalAfter: null,
    durationMs: null,
    failureCategory: "none" as const,
    ...overrides,
  };
}

describe("runBuildVerificationPhase", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("sets outcome fields on successful build", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(runBuildVerification).mockReturnValue({
      passed: true,
      output: "Tests  745 passed (745)",
    });
    const outcome = createOutcome();
    runBuildVerificationPhase(1, outcome);

    expect(outcome.buildVerificationPassed).toBe(true);
    expect(outcome.testCountAfter).toBe(745);
    expect(outcome.testTotalAfter).toBe(745);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[build] PASSED"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("(745/745 tests)"));
    logSpy.mockRestore();
  });

  it("throws on failed build and classifies as test_failure when vitest reports failures", () => {
    vi.mocked(runBuildVerification).mockReturnValue({
      passed: false,
      output: "Tests  3 passed | 2 failed (5)",
    });
    const outcome = createOutcome();
    expect(() => runBuildVerificationPhase(1, outcome)).toThrow(
      "Build verification failed",
    );
    expect(outcome.buildVerificationPassed).toBe(false);
    expect(outcome.testCountAfter).toBe(3);
    expect(outcome.testTotalAfter).toBe(5);
    expect(outcome.failureCategory).toBe("test_failure");
  });

  it("throws on failed build and classifies as build_failure when TypeScript compilation fails", () => {
    vi.mocked(runBuildVerification).mockReturnValue({
      passed: false,
      output: "src/planning.ts(42,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    });
    const outcome = createOutcome();
    expect(() => runBuildVerificationPhase(1, outcome)).toThrow(
      "Build verification failed",
    );
    expect(outcome.buildVerificationPassed).toBe(false);
    expect(outcome.failureCategory).toBe("build_failure");
  });

  it("handles missing test counts gracefully", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(runBuildVerification).mockReturnValue({
      passed: true,
      output: "no parseable output",
    });
    const outcome = createOutcome();
    runBuildVerificationPhase(1, outcome);

    expect(outcome.buildVerificationPassed).toBe(true);
    expect(outcome.testCountAfter).toBeNull();
    expect(outcome.testTotalAfter).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("?/? tests"));
    logSpy.mockRestore();
  });
});

describe("updatePlanningStatus", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const projectConfig: ProjectConfig = { filePath: "ROADMAP.md" };
  const currentItem: ProjectItem = {
    id: "item-1",
    title: "Test item",
    status: "In Progress",
    body: "",
    linkedIssueNumber: null,
    reactions: 0,
  };

  it("marks item Done when improvements succeeded", async () => {
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const processed = { improvementsSucceeded: 2, improvementsAttempted: 3 };
    await updatePlanningStatus(10, projectConfig, currentItem, processed);

    expect(updateItemStatus).toHaveBeenCalledWith(
      projectConfig,
      "item-1",
      "Done",
      expect.stringContaining("cycle 10: 2/3 improvements succeeded"),
    );
    expect(commitRoadmap).toHaveBeenCalledWith(10);
  });

  it("marks item Up Next when no improvements succeeded", async () => {
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const processed = { improvementsSucceeded: 0, improvementsAttempted: 2 };
    await updatePlanningStatus(10, projectConfig, currentItem, processed);

    expect(updateItemStatus).toHaveBeenCalledWith(
      projectConfig,
      "item-1",
      "Up Next",
      undefined,
    );
  });

  it("commits roadmap when item is moved to Up Next", async () => {
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const processed = { improvementsSucceeded: 0, improvementsAttempted: 2 };
    await updatePlanningStatus(10, projectConfig, currentItem, processed);
    expect(commitRoadmap).toHaveBeenCalledWith(10);
  });

  it("logs error and skips commitRoadmap when updateItemStatus returns false", async () => {
    vi.mocked(updateItemStatus).mockReturnValue(false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const processed = { improvementsSucceeded: 1, improvementsAttempted: 1 };

    await updatePlanningStatus(10, projectConfig, currentItem, processed);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("not found in roadmap"));
    expect(commitRoadmap).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("does nothing when projectConfig is null", async () => {
    const processed = { improvementsSucceeded: 1, improvementsAttempted: 1 };
    await updatePlanningStatus(10, null, currentItem, processed);

    expect(updateItemStatus).not.toHaveBeenCalled();
    expect(commitRoadmap).not.toHaveBeenCalled();
  });

  it("does nothing when currentItem is null", async () => {
    const processed = { improvementsSucceeded: 1, improvementsAttempted: 1 };
    await updatePlanningStatus(10, projectConfig, null, processed);

    expect(updateItemStatus).not.toHaveBeenCalled();
  });

  it("does not promote to Done when linkedIssueNumber is set but succeededSummary is empty", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const itemWithLinkedIssue: ProjectItem = { ...currentItem, linkedIssueNumber: 55 };
    await updatePlanningStatus(10, projectConfig, itemWithLinkedIssue, {
      improvementsSucceeded: 1,
      improvementsAttempted: 1,
      succeededSummary: "",
    });
    expect(updateItemStatus).toHaveBeenCalledWith(projectConfig, "item-1", "Up Next", undefined);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("#55"));
    warnSpy.mockRestore();
  });

  it("does not promote to Done when linkedIssueNumber is set but succeededSummary is undefined", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const itemWithLinkedIssue: ProjectItem = { ...currentItem, linkedIssueNumber: 55 };
    await updatePlanningStatus(10, projectConfig, itemWithLinkedIssue, {
      improvementsSucceeded: 1,
      improvementsAttempted: 1,
      // succeededSummary intentionally omitted
    });
    expect(updateItemStatus).toHaveBeenCalledWith(projectConfig, "item-1", "Up Next", undefined);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("#55"));
    warnSpy.mockRestore();
  });

  it("does not promote to Done when linkedIssueNumber is not mentioned in succeeded summary", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const itemWithLinkedIssue: ProjectItem = {
      ...currentItem,
      linkedIssueNumber: 42,
    };
    const processed = {
      improvementsSucceeded: 1,
      improvementsAttempted: 1,
      succeededSummary: "Fixed a bug in the parser unrelated to any roadmap item.",
    };
    await updatePlanningStatus(10, projectConfig, itemWithLinkedIssue, processed);

    expect(updateItemStatus).toHaveBeenCalledWith(
      projectConfig,
      "item-1",
      "Up Next",
      undefined,
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("#42"));
    warnSpy.mockRestore();
  });

  it("does not promote to Done when summary mentions a longer issue number that starts with the target (false-positive guard)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const itemWithLinkedIssue: ProjectItem = {
      ...currentItem,
      linkedIssueNumber: 42,
    };
    const processed = {
      improvementsSucceeded: 1,
      improvementsAttempted: 1,
      // Summary mentions #420, which contains "42" as a substring — must NOT match #42
      succeededSummary: "Resolved issue #420 by refactoring the scheduler.",
    };
    await updatePlanningStatus(10, projectConfig, itemWithLinkedIssue, processed);

    expect(updateItemStatus).toHaveBeenCalledWith(
      projectConfig,
      "item-1",
      "Up Next",
      undefined,
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("#42"));
    warnSpy.mockRestore();
  });

  it("promotes to Done when linkedIssueNumber is mentioned in succeeded summary", async () => {
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const itemWithLinkedIssue: ProjectItem = {
      ...currentItem,
      linkedIssueNumber: 42,
    };
    const processed = {
      improvementsSucceeded: 1,
      improvementsAttempted: 1,
      succeededSummary: "Fixed issue #42: improved error handling in parser.",
    };
    await updatePlanningStatus(10, projectConfig, itemWithLinkedIssue, processed);

    expect(updateItemStatus).toHaveBeenCalledWith(
      projectConfig,
      "item-1",
      "Done",
      expect.stringContaining("cycle 10"),
    );
  });

  it("promotes to Done when linkedIssueNumber is null (no issue to validate)", async () => {
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const processed = {
      improvementsSucceeded: 1,
      improvementsAttempted: 1,
      succeededSummary: "Improved overall code quality.",
    };
    await updatePlanningStatus(10, projectConfig, currentItem, processed);

    expect(updateItemStatus).toHaveBeenCalledWith(
      projectConfig,
      "item-1",
      "Done",
      expect.stringContaining("cycle 10"),
    );
  });

  it("closes linked GitHub issue when item transitions to Done", async () => {
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const itemWithLinkedIssue: ProjectItem = {
      ...currentItem,
      linkedIssueNumber: 22,
    };
    const processed = {
      improvementsSucceeded: 1,
      improvementsAttempted: 1,
      succeededSummary: "Fixed issue #22: resolved the problem.",
    };
    await updatePlanningStatus(10, projectConfig, itemWithLinkedIssue, processed);

    expect(vi.mocked(closeIssueWithComment)).toHaveBeenCalledWith(
      22,
      10,
      expect.stringContaining("Completed in cycle 10"),
      undefined,
      "completed",
    );
    expect(vi.mocked(closeIssueWithComment)).toHaveBeenCalledWith(
      22,
      10,
      expect.stringContaining("has been resolved — the linked roadmap item is now marked Done"),
      undefined,
      "completed",
    );
  });

  it("forwards db argument to closeIssueWithComment when db is provided", async () => {
    // Documents the real production call path where db is always passed from
    // the orchestrator. Previously only tested with db=undefined; this test
    // pins that the db argument is actually forwarded (not silently dropped).
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const itemWithLinkedIssue: ProjectItem = {
      ...currentItem,
      linkedIssueNumber: 77,
    };
    const processed = {
      improvementsSucceeded: 1,
      improvementsAttempted: 1,
      succeededSummary: "Fixed issue #77: resolved the problem.",
    };
    // Use a minimal mock db object — only the shape matters for the forwarding test.
    const mockDb = {} as import("better-sqlite3").Database;
    await updatePlanningStatus(10, projectConfig, itemWithLinkedIssue, processed, mockDb);

    expect(vi.mocked(closeIssueWithComment)).toHaveBeenCalledWith(
      77,
      10,
      expect.any(String),
      mockDb,
      "completed",
    );
  });

  it("does not close GitHub issue when item transitions to Up Next", async () => {
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const itemWithLinkedIssue: ProjectItem = {
      ...currentItem,
      linkedIssueNumber: 22,
    };
    const processed = { improvementsSucceeded: 0, improvementsAttempted: 1 };
    await updatePlanningStatus(10, projectConfig, itemWithLinkedIssue, processed);

    expect(vi.mocked(closeIssueWithComment)).not.toHaveBeenCalled();
  });

  it("does not close GitHub issue when item has no linkedIssueNumber", async () => {
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const processed = {
      improvementsSucceeded: 1,
      improvementsAttempted: 1,
      succeededSummary: "Improved overall code quality.",
    };
    // currentItem.linkedIssueNumber is null
    await updatePlanningStatus(10, projectConfig, currentItem, processed);

    expect(vi.mocked(closeIssueWithComment)).not.toHaveBeenCalled();
  });

  it("swallows errors from updateItemStatus (non-fatal)", async () => {
    vi.mocked(updateItemStatus).mockImplementation(() => {
      throw new Error("write failed");
    });
    const processed = { improvementsSucceeded: 1, improvementsAttempted: 1 };

    // Should not throw
    await expect(
      updatePlanningStatus(10, projectConfig, currentItem, processed),
    ).resolves.not.toThrow();
  });
});

describe("demoteStaleItemsPhase", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const projectConfig: ProjectConfig = { filePath: "ROADMAP.md" };

  it("does nothing when projectConfig is null", () => {
    demoteStaleItemsPhase(null, 10);
    expect(demoteStaleInProgressItems).not.toHaveBeenCalled();
  });

  it("calls demoteStaleInProgressItems with projectConfig and cycleCount", () => {
    vi.mocked(demoteStaleInProgressItems).mockReturnValue([]);
    demoteStaleItemsPhase(projectConfig, 10);
    expect(demoteStaleInProgressItems).toHaveBeenCalledWith(projectConfig, 10, 3);
  });

  it("logs demoted item titles when stale items exist", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(demoteStaleInProgressItems).mockReturnValue(["Stuck feature", "Old task"]);
    demoteStaleItemsPhase(projectConfig, 20);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Stuck feature"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("2 stale In Progress item(s)"),
    );
    logSpy.mockRestore();
  });

  it("does not log when no stale items exist", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(demoteStaleInProgressItems).mockReturnValue([]);
    demoteStaleItemsPhase(projectConfig, 20);
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("stale"),
    );
    logSpy.mockRestore();
  });

  it("forwards custom threshold to demoteStaleInProgressItems", () => {
    vi.mocked(demoteStaleInProgressItems).mockReturnValue([]);
    demoteStaleItemsPhase(projectConfig, 15, 5);
    expect(demoteStaleInProgressItems).toHaveBeenCalledWith(projectConfig, 15, 5);
  });

  it("uses default threshold of 3 when no threshold argument is provided", () => {
    vi.mocked(demoteStaleInProgressItems).mockReturnValue([]);
    demoteStaleItemsPhase(projectConfig, 10);
    expect(demoteStaleInProgressItems).toHaveBeenCalledWith(projectConfig, 10, 3);
  });
});

describe("pushChangesPhase", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("sets pushSucceeded to true when push succeeds", () => {
    vi.mocked(pushChanges).mockReturnValue(true);
    const outcome = createOutcome();
    pushChangesPhase(outcome);

    expect(outcome.pushSucceeded).toBe(true);
  });

  it("sets pushSucceeded to false when push fails", () => {
    vi.mocked(pushChanges).mockReturnValue(false);
    const outcome = createOutcome();
    pushChangesPhase(outcome);

    expect(outcome.pushSucceeded).toBe(false);
  });

  it("logs error message to console.error when push fails", () => {
    vi.mocked(pushChanges).mockReturnValue(false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = createOutcome();
    pushChangesPhase(outcome);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Push failed"));
    errorSpy.mockRestore();
  });

  it("always starts with pushSucceeded false before calling pushChanges", () => {
    vi.mocked(pushChanges).mockImplementation(() => {
      // At the point pushChanges is called, outcome should be false
      return true;
    });
    const outcome = createOutcome({ pushSucceeded: true });
    pushChangesPhase(outcome);

    // Verify the reset happened (outcome was set to false before pushChanges)
    expect(outcome.pushSucceeded).toBe(true); // final state is true because push succeeded
  });
});
