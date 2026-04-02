import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Module mocks (hoisted by vitest before any imports) ---

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn().mockReturnValue("mock identity content"),
}));

vi.mock("../src/db.js", () => ({
  initDb: vi.fn().mockReturnValue({ close: vi.fn() }),
  getLatestCycleNumber: vi.fn().mockReturnValue(185),
  getRecentJournalSummary: vi.fn().mockReturnValue("mock journal summary"),
  getCycleStats: vi.fn().mockReturnValue({}),
  formatCycleStats: vi.fn().mockReturnValue("mock stats text"),
}));

vi.mock("../src/evolve.js", () => ({
  buildAssessmentPrompt: vi.fn().mockReturnValue("mock assessment prompt"),
}));

vi.mock("../src/errors.js", () => ({
  errorMessage: vi.fn((e: unknown) => String(e)),
}));

vi.mock("../src/memory.js", () => ({
  formatMemoryForPrompt: vi.fn().mockReturnValue("mock memory context"),
}));

vi.mock("../src/planning.js", () => ({
  ensureProject: vi.fn().mockReturnValue({ filePath: "ROADMAP.md" }),
  getProjectItems: vi.fn().mockReturnValue([]),
  formatPlanningContext: vi.fn().mockReturnValue("mock planning context"),
}));

vi.mock("../src/usage.js", () => ({
  extractResultText: vi.fn(),
  formatDurationSec: vi.fn().mockReturnValue("1.00s"),
}));

vi.mock("../src/agent-phases.js", () => ({
  resolveModel: vi.fn().mockReturnValue("claude-opus-4-5"),
}));

// --- Import after mocks are set up ---

import { query } from "@anthropic-ai/claude-agent-sdk";
import { extractResultText } from "../src/usage.js";
import { buildAssessmentPrompt } from "../src/evolve.js";
import { ensureProject, getProjectItems } from "../src/planning.js";
import { main } from "../src/assess.js";

const mockQuery = vi.mocked(query);
const mockExtractResultText = vi.mocked(extractResultText);
const mockBuildAssessmentPrompt = vi.mocked(buildAssessmentPrompt);
const mockEnsureProject = vi.mocked(ensureProject);
const mockGetProjectItems = vi.mocked(getProjectItems);

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
    vi.clearAllMocks();
    // Default: query yields nothing; extractResultText returns null by default.
    mockQuery.mockReturnValue(mockGen([]));
    mockExtractResultText.mockReturnValue(null);
    mockEnsureProject.mockReturnValue({ filePath: "ROADMAP.md" });
    mockGetProjectItems.mockReturnValue([]);
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
});
