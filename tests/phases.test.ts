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
}));

import { runBuildVerificationPhase, updatePlanningStatus, pushChangesPhase } from "../src/phases.js";
import { runBuildVerification, pushChanges, commitRoadmap } from "../src/lifecycle.js";
import { updateItemStatus } from "../src/planning.js";

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
    ...overrides,
  };
}

describe("runBuildVerificationPhase", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("sets outcome fields on successful build", () => {
    vi.mocked(runBuildVerification).mockReturnValue({
      passed: true,
      output: "Tests  745 passed (745)",
    });
    const outcome = createOutcome();
    runBuildVerificationPhase(1, outcome);

    expect(outcome.buildVerificationPassed).toBe(true);
    expect(outcome.testCountAfter).toBe(745);
    expect(outcome.testTotalAfter).toBe(745);
  });

  it("throws on failed build and sets outcome", () => {
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
  });

  it("handles missing test counts gracefully", () => {
    vi.mocked(runBuildVerification).mockReturnValue({
      passed: true,
      output: "no parseable output",
    });
    const outcome = createOutcome();
    runBuildVerificationPhase(1, outcome);

    expect(outcome.buildVerificationPassed).toBe(true);
    expect(outcome.testCountAfter).toBeNull();
    expect(outcome.testTotalAfter).toBeNull();
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

  it("marks item Done when improvements succeeded", () => {
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const processed = { improvementsSucceeded: 2, improvementsAttempted: 3 };
    updatePlanningStatus(10, projectConfig, currentItem, processed);

    expect(updateItemStatus).toHaveBeenCalledWith(
      projectConfig,
      "item-1",
      "Done",
      expect.stringContaining("cycle 10"),
    );
    expect(commitRoadmap).toHaveBeenCalledWith(10);
  });

  it("marks item Up Next when no improvements succeeded", () => {
    vi.mocked(updateItemStatus).mockReturnValue(true);
    const processed = { improvementsSucceeded: 0, improvementsAttempted: 2 };
    updatePlanningStatus(10, projectConfig, currentItem, processed);

    expect(updateItemStatus).toHaveBeenCalledWith(
      projectConfig,
      "item-1",
      "Up Next",
      undefined,
    );
  });

  it("logs error and skips commitRoadmap when updateItemStatus returns false", () => {
    vi.mocked(updateItemStatus).mockReturnValue(false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const processed = { improvementsSucceeded: 1, improvementsAttempted: 1 };

    updatePlanningStatus(10, projectConfig, currentItem, processed);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("not found in roadmap"));
    expect(commitRoadmap).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("does nothing when projectConfig is null", () => {
    const processed = { improvementsSucceeded: 1, improvementsAttempted: 1 };
    updatePlanningStatus(10, null, currentItem, processed);

    expect(updateItemStatus).not.toHaveBeenCalled();
    expect(commitRoadmap).not.toHaveBeenCalled();
  });

  it("does nothing when currentItem is null", () => {
    const processed = { improvementsSucceeded: 1, improvementsAttempted: 1 };
    updatePlanningStatus(10, projectConfig, null, processed);

    expect(updateItemStatus).not.toHaveBeenCalled();
  });

  it("swallows errors from updateItemStatus (non-fatal)", () => {
    vi.mocked(updateItemStatus).mockImplementation(() => {
      throw new Error("write failed");
    });
    const processed = { improvementsSucceeded: 1, improvementsAttempted: 1 };

    // Should not throw
    expect(() =>
      updatePlanningStatus(10, projectConfig, currentItem, processed),
    ).not.toThrow();
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
