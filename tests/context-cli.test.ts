import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Module mocks (hoisted by vitest before any imports) ---

vi.mock("../src/db.js", () => ({
  initDb: vi.fn(),
  getLatestCycleNumber: vi.fn(),
}));

vi.mock("../src/context.js", () => ({
  loadEvolutionContext: vi.fn(),
}));

vi.mock("../src/errors.js", () => ({
  errorMessage: vi.fn((err: unknown) => String(err)),
}));

vi.mock("../src/stats.js", () => ({
  parseVerboseFlag: vi.fn().mockReturnValue(false),
  parseHelpFlag: vi.fn().mockReturnValue(false),
  parseCycleArg: vi.fn().mockReturnValue(undefined),
  parseDryRunFlag: vi.fn().mockReturnValue(false),
}));

// --- Import after mocks are set up ---

import { initDb, getLatestCycleNumber } from "../src/db.js";
import { loadEvolutionContext } from "../src/context.js";
import { parseVerboseFlag, parseHelpFlag, parseCycleArg, parseDryRunFlag } from "../src/stats.js";
import { main, CONTEXT_CLI_HELP_TEXT, renderDryRunBreakdown } from "../src/context-cli.js";

const mockInitDb = vi.mocked(initDb);
const mockGetLatestCycleNumber = vi.mocked(getLatestCycleNumber);
const mockLoadEvolutionContext = vi.mocked(loadEvolutionContext);
const mockParseVerboseFlag = vi.mocked(parseVerboseFlag);
const mockParseHelpFlag = vi.mocked(parseHelpFlag);
const mockParseCycleArg = vi.mocked(parseCycleArg);
const mockParseDryRunFlag = vi.mocked(parseDryRunFlag);

function makeCtx(overrides = {}) {
  return {
    identity: "# Identity content",
    journalSummary: "journal text",
    cycleStatsText: "stats text",
    memoryContext: "memory text",
    planningContext: "## Evolution Roadmap",
    issues: [],
    projectConfig: null,
    currentItem: null,
    ...overrides,
  };
}

describe("context-cli.ts CONTEXT_CLI_HELP_TEXT", () => {
  it("contains --verbose and --help flags", () => {
    expect(CONTEXT_CLI_HELP_TEXT).toContain("--verbose");
    expect(CONTEXT_CLI_HELP_TEXT).toContain("--help");
  });

  it("contains --dry-run flag", () => {
    expect(CONTEXT_CLI_HELP_TEXT).toContain("--dry-run");
  });
});

describe("context-cli.ts renderDryRunBreakdown()", () => {
  it("renders one row per section plus a Total row", () => {
    const result = renderDryRunBreakdown([["Identity", 100], ["Journal", 400]]);
    expect(result).toContain("Identity");
    expect(result).toContain("Journal");
    expect(result).toContain("Total");
  });

  it("computes percentages correctly", () => {
    const result = renderDryRunBreakdown([["A", 50], ["B", 50]]);
    // Each section is 50% of 100 total
    expect(result).toContain("50.0%");
    expect(result).toContain("100.0%");
  });

  it("handles zero-total gracefully (shows 0.0% for all sections)", () => {
    const result = renderDryRunBreakdown([["Empty", 0]]);
    expect(result).toContain("0.0%");
    expect(result).toContain("100.0%");
  });

  it("--dry-run: prints breakdown and does NOT fall through to full context load", async () => {
    mockParseDryRunFlag.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInitDb.mockReturnValue({ close: vi.fn() } as any);
    mockGetLatestCycleNumber.mockReturnValue(5);
    mockLoadEvolutionContext.mockResolvedValue(makeCtx({
      identity: "ID",
      journalSummary: "JJ",
    }));
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main();

    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("Identity"))).toBe(true);
    expect(logged.some((l) => l.includes("Total"))).toBe(true);
    // Should NOT print the normal "Community issues" summary line
    expect(logged.some((l) => l.includes("Community issues:"))).toBe(false);

    consoleSpy.mockRestore();
  });

  it("--dry-run: CONTEXT_CLI_HELP_TEXT includes --dry-run description", () => {
    expect(CONTEXT_CLI_HELP_TEXT).toContain("--dry-run");
  });
});

describe("context-cli.ts main()", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInitDb.mockReturnValue({ close: vi.fn() } as any);
    mockGetLatestCycleNumber.mockReturnValue(10);
    mockLoadEvolutionContext.mockResolvedValue(makeCtx());
    mockParseVerboseFlag.mockReturnValue(false);
    mockParseHelpFlag.mockReturnValue(false);
    mockParseCycleArg.mockReturnValue(undefined);
    mockParseDryRunFlag.mockReturnValue(false);
  });

  it("--help: prints CONTEXT_CLI_HELP_TEXT and does NOT call loadEvolutionContext", async () => {
    mockParseHelpFlag.mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await main();

    expect(stdoutSpy).toHaveBeenCalledWith(CONTEXT_CLI_HELP_TEXT);
    expect(mockLoadEvolutionContext).not.toHaveBeenCalled();

    stdoutSpy.mockRestore();
  });

  it("--help: exits before opening the DB", async () => {
    mockParseHelpFlag.mockReturnValue(true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await main();

    expect(mockInitDb).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("calls loadEvolutionContext with cycleCount one above getLatestCycleNumber", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockGetLatestCycleNumber.mockReturnValue(41);

    await main();

    expect(mockLoadEvolutionContext).toHaveBeenCalledWith(expect.anything(), 42);
  });

  it("prints a summary line for each context section", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockLoadEvolutionContext.mockResolvedValue(makeCtx({
      identity: "# ID",
      journalSummary: "jrnl",
      issues: [{ number: 1, title: "Bug", body: "", reactions: 0, labels: [] }],
    }));

    await main();

    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("Identity:"))).toBe(true);
    expect(logged.some((l) => l.includes("Journal summary:"))).toBe(true);
    expect(logged.some((l) => l.includes("Community issues: 1"))).toBe(true);

    consoleSpy.mockRestore();
  });

  it("prints a Total context chars summary line summing all section lengths", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockLoadEvolutionContext.mockResolvedValue(makeCtx({
      identity: "AB",          // 2
      journalSummary: "CDE",   // 3
      cycleStatsText: "FG",    // 2
      memoryContext: "H",      // 1
      planningContext: "IJKL", // 4
    }));

    await main();

    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    // 2 + 3 + 2 + 1 + 4 = 12
    expect(logged.some((l) => l.includes("Total context:") && l.includes("12 chars"))).toBe(true);

    consoleSpy.mockRestore();
  });

  it("Total context chars counts only identity when all other sections are empty", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockLoadEvolutionContext.mockResolvedValue(makeCtx({
      identity: "HELLO",       // 5
      journalSummary: "",
      cycleStatsText: "",
      memoryContext: "",
      planningContext: "",
    }));

    await main();

    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("Total context:") && l.includes("5 chars"))).toBe(true);

    consoleSpy.mockRestore();
  });

  it("--verbose: prints full identity section", async () => {
    mockParseVerboseFlag.mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockLoadEvolutionContext.mockResolvedValue(makeCtx({ identity: "FULL IDENTITY TEXT" }));

    await main();

    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("FULL IDENTITY TEXT"))).toBe(true);

    consoleSpy.mockRestore();
  });

  it("--verbose: prints full planning context section when non-empty", async () => {
    mockParseVerboseFlag.mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockLoadEvolutionContext.mockResolvedValue(makeCtx({ planningContext: "ROADMAP CONTENT" }));

    await main();

    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("ROADMAP CONTENT"))).toBe(true);

    consoleSpy.mockRestore();
  });

  it("--verbose: prints full cycleStatsText section when non-empty", async () => {
    // Regression guard: if the cycleStatsText block is accidentally dropped from
    // the verbose output path, the stats section goes blank with no failing test.
    mockParseVerboseFlag.mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockLoadEvolutionContext.mockResolvedValue(makeCtx({ cycleStatsText: "CYCLE STATS CONTENT" }));

    await main();

    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("CYCLE STATS CONTENT"))).toBe(true);

    consoleSpy.mockRestore();
  });

  it("--verbose: skips cycleStatsText section when empty", async () => {
    // Guard the conditional: when cycleStatsText is falsy the section header
    // must be absent so the output stays clean.
    mockParseVerboseFlag.mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockLoadEvolutionContext.mockResolvedValue(makeCtx({ cycleStatsText: "" }));

    await main();

    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("Cycle Stats"))).toBe(false);

    consoleSpy.mockRestore();
  });

  it("--verbose: prints full memoryContext section when non-empty", async () => {
    // Regression guard: if the memoryContext block is accidentally dropped from
    // the verbose output path, accumulated learnings go blank with no failing test.
    mockParseVerboseFlag.mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockLoadEvolutionContext.mockResolvedValue(makeCtx({ memoryContext: "MEMORY CONTEXT CONTENT" }));

    await main();

    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("MEMORY CONTEXT CONTENT"))).toBe(true);

    consoleSpy.mockRestore();
  });

  it("--verbose: skips memoryContext section when empty", async () => {
    // Guard the conditional: when memoryContext is falsy the section header
    // must be absent so the output stays clean.
    mockParseVerboseFlag.mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockLoadEvolutionContext.mockResolvedValue(makeCtx({ memoryContext: "" }));

    await main();

    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("Memory Context"))).toBe(false);

    consoleSpy.mockRestore();
  });

  it("non-verbose mode does NOT print full identity text", async () => {
    mockParseVerboseFlag.mockReturnValue(false);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockLoadEvolutionContext.mockResolvedValue(makeCtx({ identity: "PRIVATE IDENTITY" }));

    await main();

    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("PRIVATE IDENTITY"))).toBe(false);

    consoleSpy.mockRestore();
  });

  it("closes the DB after loadEvolutionContext resolves", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    await main();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockDb = (mockInitDb.mock.results[0].value as any);
    expect(mockDb.close).toHaveBeenCalledOnce();
  });

  it("continues (non-fatal) when getLatestCycleNumber throws — cycleCount stays 0", async () => {
    mockGetLatestCycleNumber.mockImplementation(() => {
      throw new Error("DB locked");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await main();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[context-cli] Could not load cycle number (non-fatal)")
    );
    // cycleCount defaults to 0
    expect(mockLoadEvolutionContext).toHaveBeenCalledWith(expect.anything(), 0);

    errorSpy.mockRestore();
  });

  it("--cycle N: passes N directly to loadEvolutionContext without calling getLatestCycleNumber", async () => {
    mockParseCycleArg.mockReturnValue(5);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await main();

    expect(mockLoadEvolutionContext).toHaveBeenCalledWith(expect.anything(), 5);
    expect(mockGetLatestCycleNumber).not.toHaveBeenCalled();
  });

  it("--cycle N: summary header shows the pinned cycle number", async () => {
    mockParseCycleArg.mockReturnValue(42);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main();

    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("Cycle:") && l.includes("42"))).toBe(true);
  });

  it("summary prints cycle number even without --cycle flag", async () => {
    mockGetLatestCycleNumber.mockReturnValue(99);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main();

    const logged = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logged.some((l) => l.includes("Cycle:") && l.includes("100"))).toBe(true);

    consoleSpy.mockRestore();
  });

  it("CONTEXT_CLI_HELP_TEXT includes --cycle flag", () => {
    expect(CONTEXT_CLI_HELP_TEXT).toContain("--cycle");
  });

  it("closes DB and logs error when loadEvolutionContext throws, then exits", async () => {
    mockLoadEvolutionContext.mockRejectedValue(new Error("identity missing"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });

    await expect(main()).rejects.toThrow("process.exit called");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[context-cli] Failed to load evolution context")
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockDb = (mockInitDb.mock.results[0].value as any);
    expect(mockDb.close).toHaveBeenCalledOnce();

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
