import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Module mocks (hoisted by vitest before any imports) ---

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
}));

vi.mock("../src/db.js", () => ({
  initDb: vi.fn(),
  getLatestCycleNumber: vi.fn(),
  getRecentJournalSummary: vi.fn(),
  getCycleStats: vi.fn(),
  formatCycleStats: vi.fn(),
}));

vi.mock("../src/evolve.js", () => ({
  buildAssessmentPrompt: vi.fn(),
}));

vi.mock("../src/errors.js", () => ({
  errorMessage: vi.fn(),
}));

vi.mock("../src/memory.js", () => ({
  formatMemoryForPrompt: vi.fn(),
}));

vi.mock("../src/planning.js", () => ({
  ensureProject: vi.fn(),
  getProjectItems: vi.fn(),
  formatPlanningContext: vi.fn(),
}));

vi.mock("../src/usage.js", () => ({
  extractResultText: vi.fn(),
  formatDurationSec: vi.fn(),
}));

vi.mock("../src/agent-phases.js", () => ({
  resolveModel: vi.fn(),
}));

// --- Import after mocks are set up ---

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import {
  initDb,
  getLatestCycleNumber,
  getRecentJournalSummary,
  getCycleStats,
  formatCycleStats,
} from "../src/db.js";
import { extractResultText, formatDurationSec } from "../src/usage.js";
import { buildAssessmentPrompt } from "../src/evolve.js";
import { errorMessage } from "../src/errors.js";
import { ensureProject, getProjectItems, formatPlanningContext } from "../src/planning.js";
import { formatMemoryForPrompt } from "../src/memory.js";
import { resolveModel } from "../src/agent-phases.js";
import { main } from "../src/assess.js";

const mockQuery = vi.mocked(query);
const mockExtractResultText = vi.mocked(extractResultText);
const mockFormatDurationSec = vi.mocked(formatDurationSec);
const mockBuildAssessmentPrompt = vi.mocked(buildAssessmentPrompt);
const mockEnsureProject = vi.mocked(ensureProject);
const mockGetProjectItems = vi.mocked(getProjectItems);
const mockFormatPlanningContext = vi.mocked(formatPlanningContext);
const mockGetLatestCycleNumber = vi.mocked(getLatestCycleNumber);
const mockReadFileSync = vi.mocked(readFileSync);
const mockGetRecentJournalSummary = vi.mocked(getRecentJournalSummary);
const mockFormatMemoryForPrompt = vi.mocked(formatMemoryForPrompt);
const mockFormatCycleStats = vi.mocked(formatCycleStats);
const mockInitDb = vi.mocked(initDb);
const mockGetCycleStats = vi.mocked(getCycleStats);
const mockResolveModel = vi.mocked(resolveModel);
const mockErrorMessage = vi.mocked(errorMessage);

// Helper: create an async generator that yields the provided messages.
// Cast to `never` is required because the SDK's Query type extends AsyncGenerator
// with extra control methods (interrupt, setModel, etc.) that we don't need in tests.
async function* makeGen(messages: unknown[]): AsyncGenerator<unknown> {
  for (const msg of messages) yield msg;
}
function mockGen(messages: unknown[]) {
  return makeGen(messages) as never;
}

describe("assess.ts main()", () => {
  beforeEach(() => {
    // resetAllMocks clears both call history AND implementations, preventing
    // mockImplementation(() => { throw ... }) leaks from one test into the next.
    vi.resetAllMocks();
    // Restore factory defaults cleared by resetAllMocks.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInitDb.mockReturnValue({ close: vi.fn() } as any);
    mockGetLatestCycleNumber.mockReturnValue(185);
    mockReadFileSync.mockReturnValue("mock identity content");
    mockGetRecentJournalSummary.mockReturnValue("mock journal summary");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetCycleStats.mockReturnValue({} as any);
    mockFormatCycleStats.mockReturnValue("mock stats text");
    mockFormatMemoryForPrompt.mockReturnValue("mock memory context");
    mockBuildAssessmentPrompt.mockReturnValue("mock assessment prompt");
    mockEnsureProject.mockReturnValue({ filePath: "ROADMAP.md" });
    mockGetProjectItems.mockReturnValue([]);
    mockFormatPlanningContext.mockReturnValue("mock planning context");
    mockQuery.mockReturnValue(mockGen([]));
    mockExtractResultText.mockReturnValue(null);
    mockFormatDurationSec.mockReturnValue("1.00s");
    mockResolveModel.mockReturnValue("claude-opus-4-5");
    mockErrorMessage.mockImplementation((e: unknown) => String(e));
  });

  it("calls buildAssessmentPrompt with cycleCount one above the latest cycle", async () => {
    await main();
    const call = mockBuildAssessmentPrompt.mock.calls[0][0];
    // getLatestCycleNumber returns 185, so cycleCount = 186
    expect(call.cycleCount).toBe(186);
  });

  it("calls query with the prompt returned by buildAssessmentPrompt", async () => {
    mockBuildAssessmentPrompt.mockReturnValue("custom prompt");
    await main();
    expect(mockQuery).toHaveBeenCalledOnce();
    const { prompt } = mockQuery.mock.calls[0][0];
    expect(prompt).toBe("custom prompt");
  });

  it("extracts assessment result from the result message yielded by query", async () => {
    const resultMsg = { type: "result", result: "top 3 improvements" };
    mockQuery.mockReturnValue(mockGen([resultMsg]));
    mockExtractResultText.mockImplementation((msg) =>
      msg === resultMsg ? "top 3 improvements" : null,
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await main();
    // The final console.log should output the extracted assessment
    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("top 3 improvements"))).toBe(true);
    consoleSpy.mockRestore();
  });

  it("prints fallback message when no result is extracted from query", async () => {
    mockQuery.mockReturnValue(mockGen([{ type: "text", text: "thinking..." }]));
    mockExtractResultText.mockReturnValue(null);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await main();
    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("(no output produced)"))).toBe(true);
    consoleSpy.mockRestore();
  });

  it("continues (non-fatal) when planning context loading throws", async () => {
    mockEnsureProject.mockImplementation(() => {
      throw new Error("ROADMAP.md not found");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Should not throw — the try/catch in main() makes it non-fatal
    await expect(main()).resolves.toBeUndefined();

    // The error must be surfaced via console.error, not silently swallowed
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Planning context unavailable (non-fatal)")
    );

    errorSpy.mockRestore();
  });

  it("counts message turns from the query generator", async () => {
    const messages = [
      { type: "text", text: "thinking" },
      { type: "text", text: "more thinking" },
      { type: "result", result: "done" },
    ];
    mockQuery.mockReturnValue(mockGen(messages));
    mockExtractResultText.mockImplementation((msg) =>
      (msg as { type: string; result?: string }).type === "result"
        ? ((msg as { type: string; result: string }).result)
        : null,
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await main();
    // 3 messages were yielded; duration log should show "(3 turns)"
    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("(3 turns)"))).toBe(true);
    consoleSpy.mockRestore();
  });

  it("continues (non-fatal) when getLatestCycleNumber throws — cycleCount stays 0", async () => {
    mockGetLatestCycleNumber.mockImplementation(() => {
      throw new Error("DB locked");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(main()).resolves.toBeUndefined();

    // Error must be surfaced, not silently swallowed
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Context loading failed (non-fatal)"));

    // cycleCount defaults to 0 so buildAssessmentPrompt receives cycleCount: 0
    const call = mockBuildAssessmentPrompt.mock.calls[0][0];
    expect(call.cycleCount).toBe(0);

    errorSpy.mockRestore();
  });

  it("continues (non-fatal) when readFileSync throws — identity stays empty string", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("IDENTITY.md not found");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(main()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Context loading failed (non-fatal)"));

    // identity is "" so systemPrompt in query call is empty string, not undefined
    const { options } = mockQuery.mock.calls[0][0];
    expect(options?.systemPrompt).toBe("");

    errorSpy.mockRestore();
  });

  it("continues (non-fatal) when getRecentJournalSummary throws — journalSummary stays empty", async () => {
    mockGetRecentJournalSummary.mockImplementation(() => {
      throw new Error("journal table missing");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(main()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Context loading failed (non-fatal)"));

    // journalSummary defaults to "" so buildAssessmentPrompt receives an empty string
    const call = mockBuildAssessmentPrompt.mock.calls[0][0];
    expect(call.journalSummary).toBe("");

    errorSpy.mockRestore();
  });

  it("passes planning context from formatPlanningContext to buildAssessmentPrompt", async () => {
    // Regression guard: if the planningContext argument is dropped from the
    // buildAssessmentPrompt call, the LLM loses roadmap awareness silently.
    // This test verifies the success path where formatPlanningContext returns
    // a string and that string flows through to buildAssessmentPrompt.
    mockFormatPlanningContext.mockReturnValueOnce("specific roadmap context");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await main();

    const call = mockBuildAssessmentPrompt.mock.calls[0][0];
    expect(call.planningContext).toBe("specific roadmap context");
  });

  it("passes memoryContext from formatMemoryForPrompt to buildAssessmentPrompt", async () => {
    // Regression guard: if the memoryContext argument is silently dropped from
    // the buildAssessmentPrompt call, accumulated knowledge is lost with no
    // failure signal.
    mockFormatMemoryForPrompt.mockImplementation(() => "specific memory context");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await main();

    const call = mockBuildAssessmentPrompt.mock.calls[0][0];
    expect(call.memoryContext).toBe("specific memory context");
  });

  it("passes cycleStatsText from formatCycleStats to buildAssessmentPrompt", async () => {
    // Regression guard: if cycleStatsText is silently dropped, the track-record
    // section of the assessment prompt goes blank with no failure signal.
    mockFormatCycleStats.mockImplementation(() => "specific stats text");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await main();

    const call = mockBuildAssessmentPrompt.mock.calls[0][0];
    expect(call.cycleStatsText).toBe("specific stats text");
  });

  it("continues (non-fatal) when formatMemoryForPrompt throws — memoryContext stays empty", async () => {
    mockFormatMemoryForPrompt.mockImplementation(() => {
      throw new Error("memory DB corrupted");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(main()).resolves.toBeUndefined();

    // Error must be surfaced, not silently swallowed
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Context loading failed (non-fatal)")
    );

    // memoryContext defaults to "" so buildAssessmentPrompt receives an empty string
    const call = mockBuildAssessmentPrompt.mock.calls[0][0];
    expect(call.memoryContext).toBe("");

    errorSpy.mockRestore();
  });

  it("calls query with correct safety-relevant options", async () => {
    // Guard: if permissionMode, allowedTools, maxTurns, or maxBudgetUsd are
    // accidentally changed, no other test would catch the regression silently.
    await main();
    expect(mockQuery).toHaveBeenCalledOnce();
    const { options } = mockQuery.mock.calls[0][0];
    expect(options?.permissionMode).toBe("dontAsk");
    expect(options?.allowedTools).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(options?.maxTurns).toBe(20);
    expect(options?.maxBudgetUsd).toBe(2.0);
  });
});
