import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { runAssessmentPhase, runEvolutionPhase, createDefaultDeps, type QueryFn, type PhaseDeps, type SafetyHooks } from "../src/agent-phases.js";
import type { PhaseUsage } from "../src/usage.js";
import type { EvolutionContext } from "../src/context.js";
import type { CycleOutcome } from "../src/outcomes.js";
import type { ProcessedEvolution } from "../src/orchestrator.js";

// --- Test Helpers ---

function createMockDb(): Database.Database {
  return {} as Database.Database;
}

function createEvolutionContext(overrides: Partial<EvolutionContext> = {}): EvolutionContext {
  return {
    identity: "Test identity",
    journalSummary: "Test journal",
    cycleStatsText: "Test stats",
    memoryContext: "Test memory",
    planningContext: "Test planning",
    issues: [],
    projectConfig: null,
    currentItem: null,
    ...overrides,
  };
}

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

function createProcessedEvolution(overrides: Partial<ProcessedEvolution> = {}): ProcessedEvolution {
  return {
    journalSections: { attempted: "", succeeded: "", failed: "", learnings: "", strategic_context: "" },
    improvementsAttempted: 0,
    improvementsSucceeded: 0,
    learningsStored: 0,
    strategicContextStored: false,
    ...overrides,
  };
}

/**
 * Create a mock async generator that yields the given messages in sequence.
 */
async function* mockAsyncGenerator(messages: unknown[]): AsyncGenerator<unknown> {
  for (const msg of messages) {
    yield msg;
  }
}

/**
 * Create a QueryFn that returns a mock async generator yielding the given messages.
 * Optionally captures the params it was called with.
 */
function createMockQueryFn(messages: unknown[]): { queryFn: QueryFn; calls: Array<{ prompt: string; options: Record<string, unknown> }> } {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const queryFn: QueryFn = (params) => {
    calls.push(params);
    return mockAsyncGenerator(messages);
  };
  return { queryFn, calls };
}

function createMockDeps(messages: unknown[]): { deps: PhaseDeps; queryCalls: Array<{ prompt: string; options: Record<string, unknown> }> } {
  const { queryFn, calls } = createMockQueryFn(messages);
  return {
    deps: {
      queryFn,
      insertPhaseUsage: vi.fn(),
      processEvolutionResult: vi.fn(),
    },
    queryCalls: calls,
  };
}

function createMockSafetyHooks(): SafetyHooks {
  return {
    protectIdentity: vi.fn(),
    protectJournal: vi.fn(),
    blockDangerousCommands: vi.fn(),
  };
}

/**
 * Create a usage result message that extractUsage() will parse.
 */
function createUsageMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    result: "test assessment output",
    total_cost_usd: 0.5,
    duration_ms: 1000,
    num_turns: 5,
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 100,
    },
    ...overrides,
  };
}

// --- Tests ---

describe("runAssessmentPhase", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the assessment result from the final result message", async () => {
    const { deps } = createMockDeps([
      createUsageMessage({ result: "My assessment output" }),
    ]);
    const db = createMockDb();
    const phaseUsages: PhaseUsage[] = [];

    const result = await runAssessmentPhase(db, 1, createEvolutionContext(), phaseUsages, deps);

    expect(result).toBe("My assessment output");
  });

  it("throws when 0 turns are produced (SDK returned nothing)", async () => {
    const { deps } = createMockDeps([]);
    const db = createMockDb();

    await expect(
      runAssessmentPhase(db, 1, createEvolutionContext(), [], deps),
    ).rejects.toThrow("Assessment produced no output (0 turns)");
  });

  it("returns fallback string when turns run but yield no text content", async () => {
    const { deps } = createMockDeps([
      { type: "progress", content: "thinking..." },
    ]);
    const db = createMockDb();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runAssessmentPhase(db, 1, createEvolutionContext(), [], deps);

    expect(result).toContain("assessment phase completed");
    expect(result).toContain("no readable text output");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no text output"));
    warnSpy.mockRestore();
  });

  it("populates phaseUsages from usage messages", async () => {
    const { deps } = createMockDeps([
      createUsageMessage({ result: "assessment" }),
    ]);
    const db = createMockDb();
    const phaseUsages: PhaseUsage[] = [];

    await runAssessmentPhase(db, 1, createEvolutionContext(), phaseUsages, deps);

    expect(phaseUsages).toHaveLength(1);
    expect(phaseUsages[0].phase).toBe("Assessment");
    expect(phaseUsages[0].totalCostUsd).toBe(0.5);
    expect(phaseUsages[0].inputTokens).toBe(1000);
    expect(phaseUsages[0].outputTokens).toBe(500);
  });

  it("calls insertPhaseUsage for each usage message", async () => {
    const { deps } = createMockDeps([
      createUsageMessage({ result: "assessment" }),
    ]);
    const db = createMockDb();

    await runAssessmentPhase(db, 42, createEvolutionContext(), [], deps);

    expect(deps.insertPhaseUsage).toHaveBeenCalledWith(db, 42, expect.objectContaining({ phase: "Assessment" }));
  });

  it("uses the last result when multiple result messages are yielded", async () => {
    const { deps } = createMockDeps([
      createUsageMessage({ result: "first assessment" }),
      createUsageMessage({ result: "final assessment" }),
    ]);
    const db = createMockDb();

    const result = await runAssessmentPhase(db, 1, createEvolutionContext(), [], deps);

    expect(result).toBe("final assessment");
  });

  it("ignores non-result messages for assessment text", async () => {
    const { deps } = createMockDeps([
      { type: "progress", content: "thinking..." },
      createUsageMessage({ result: "the real assessment" }),
    ]);
    const db = createMockDb();

    const result = await runAssessmentPhase(db, 1, createEvolutionContext(), [], deps);

    expect(result).toBe("the real assessment");
  });

  it("passes correct options to queryFn", async () => {
    const { deps, queryCalls } = createMockDeps([
      createUsageMessage({ result: "assessment" }),
    ]);
    const db = createMockDb();

    await runAssessmentPhase(db, 5, createEvolutionContext(), [], deps);

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].options).toMatchObject({
      model: "claude-sonnet-4-6",
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
      permissionMode: "dontAsk",
      maxTurns: 20,
      maxBudgetUsd: 2.0,
    });
  });

  it("includes context fields in the prompt and options", async () => {
    const { deps, queryCalls } = createMockDeps([
      createUsageMessage({ result: "assessment" }),
    ]);
    const db = createMockDb();
    const ctx = createEvolutionContext({ identity: "I am Bloom" });

    await runAssessmentPhase(db, 5, ctx, [], deps);

    expect(queryCalls[0].options.systemPrompt).toBe("I am Bloom");
    expect(queryCalls[0].prompt).toContain("cycle 5");
  });

  it("handles empty async generator (no messages)", async () => {
    const { deps } = createMockDeps([]);
    const db = createMockDb();

    await expect(
      runAssessmentPhase(db, 1, createEvolutionContext(), [], deps),
    ).rejects.toThrow("Assessment produced no output");
  });

  it("skips non-usage messages for phaseUsages", async () => {
    const { deps } = createMockDeps([
      { type: "tool_use", name: "Read" },
      createUsageMessage({ result: "assessment" }),
    ]);
    const db = createMockDb();
    const phaseUsages: PhaseUsage[] = [];

    await runAssessmentPhase(db, 1, createEvolutionContext(), phaseUsages, deps);

    expect(phaseUsages).toHaveLength(1);
  });
});

describe("runEvolutionPhase", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns processed evolution result", async () => {
    const processed = createProcessedEvolution({
      improvementsAttempted: 3,
      improvementsSucceeded: 2,
    });
    const { deps } = createMockDeps([
      createUsageMessage({ result: "ATTEMPTED: 3 things\nSUCCEEDED: 2 things" }),
    ]);
    vi.mocked(deps.processEvolutionResult).mockReturnValue(processed);
    const db = createMockDb();
    const outcome = createOutcome();

    const result = await runEvolutionPhase(
      db, 1, outcome, "assessment text", "identity", [], deps, createMockSafetyHooks(),
    );

    expect(result).toBe(processed);
  });

  it("updates outcome with improvement counts from processed result", async () => {
    const processed = createProcessedEvolution({
      improvementsAttempted: 3,
      improvementsSucceeded: 2,
    });
    const { deps } = createMockDeps([
      createUsageMessage({ result: "evolution output" }),
    ]);
    vi.mocked(deps.processEvolutionResult).mockReturnValue(processed);
    const db = createMockDb();
    const outcome = createOutcome();

    await runEvolutionPhase(
      db, 1, outcome, "assessment", "identity", [], deps, createMockSafetyHooks(),
    );

    expect(outcome.improvementsAttempted).toBe(3);
    expect(outcome.improvementsSucceeded).toBe(2);
  });

  it("calls processEvolutionResult with the evolution result text", async () => {
    const { deps } = createMockDeps([
      createUsageMessage({ result: "my evolution output" }),
    ]);
    vi.mocked(deps.processEvolutionResult).mockReturnValue(createProcessedEvolution());
    const db = createMockDb();

    await runEvolutionPhase(
      db, 42, createOutcome(), "assessment", "identity", [], deps, createMockSafetyHooks(),
    );

    expect(deps.processEvolutionResult).toHaveBeenCalledWith(db, 42, "my evolution output");
  });

  it("populates phaseUsages from evolution messages", async () => {
    const { deps } = createMockDeps([
      createUsageMessage({ result: "output", total_cost_usd: 1.5 }),
    ]);
    vi.mocked(deps.processEvolutionResult).mockReturnValue(createProcessedEvolution());
    const db = createMockDb();
    const phaseUsages: PhaseUsage[] = [];

    await runEvolutionPhase(
      db, 1, createOutcome(), "assessment", "identity", phaseUsages, deps, createMockSafetyHooks(),
    );

    expect(phaseUsages).toHaveLength(1);
    expect(phaseUsages[0].phase).toBe("Evolution");
    expect(phaseUsages[0].totalCostUsd).toBe(1.5);
  });

  it("passes correct options to queryFn", async () => {
    const { deps, queryCalls } = createMockDeps([
      createUsageMessage({ result: "output" }),
    ]);
    vi.mocked(deps.processEvolutionResult).mockReturnValue(createProcessedEvolution());
    const db = createMockDb();

    await runEvolutionPhase(
      db, 1, createOutcome(), "assessment", "my identity", [], deps, createMockSafetyHooks(),
    );

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].options).toMatchObject({
      model: "claude-sonnet-4-6",
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: "acceptEdits",
      systemPrompt: "my identity",
      maxTurns: 50,
      maxBudgetUsd: 5.0,
    });
  });

  it("handles evolution with no result messages (empty string)", async () => {
    const { deps } = createMockDeps([]);
    vi.mocked(deps.processEvolutionResult).mockReturnValue(createProcessedEvolution());
    const db = createMockDb();

    await runEvolutionPhase(
      db, 1, createOutcome(), "assessment", "identity", [], deps, createMockSafetyHooks(),
    );

    expect(deps.processEvolutionResult).toHaveBeenCalledWith(db, 1, "");
  });

  it("accumulates phaseUsages from both assessment and evolution", async () => {
    const assessmentUsage: PhaseUsage = {
      phase: "Assessment",
      totalCostUsd: 0.5,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      durationMs: 1000,
      numTurns: 5,
    };
    const { deps } = createMockDeps([
      createUsageMessage({ result: "output" }),
    ]);
    vi.mocked(deps.processEvolutionResult).mockReturnValue(createProcessedEvolution());
    const db = createMockDb();
    const phaseUsages: PhaseUsage[] = [assessmentUsage];

    await runEvolutionPhase(
      db, 1, createOutcome(), "assessment", "identity", phaseUsages, deps, createMockSafetyHooks(),
    );

    expect(phaseUsages).toHaveLength(2);
    expect(phaseUsages[0].phase).toBe("Assessment");
    expect(phaseUsages[1].phase).toBe("Evolution");
  });

  it("includes safety hooks in query options", async () => {
    const { deps, queryCalls } = createMockDeps([
      createUsageMessage({ result: "output" }),
    ]);
    vi.mocked(deps.processEvolutionResult).mockReturnValue(createProcessedEvolution());
    const db = createMockDb();
    const safetyHooks = createMockSafetyHooks();

    await runEvolutionPhase(
      db, 1, createOutcome(), "assessment", "identity", [], deps, safetyHooks,
    );

    const hooks = queryCalls[0].options.hooks as Record<string, unknown>;
    expect(hooks).toBeDefined();
    expect(hooks.PreToolUse).toBeDefined();
  });

  it("calls insertPhaseUsage for evolution usage messages", async () => {
    const { deps } = createMockDeps([
      createUsageMessage({ result: "output" }),
    ]);
    vi.mocked(deps.processEvolutionResult).mockReturnValue(createProcessedEvolution());
    const db = createMockDb();

    await runEvolutionPhase(
      db, 10, createOutcome(), "assessment", "identity", [], deps, createMockSafetyHooks(),
    );

    expect(deps.insertPhaseUsage).toHaveBeenCalledWith(db, 10, expect.objectContaining({ phase: "Evolution" }));
  });

  it("logs journal section content when sections are non-empty", async () => {
    const processed = createProcessedEvolution({
      journalSections: {
        attempted: "Added feature X",
        succeeded: "Feature X works",
        failed: "",
        learnings: "",
        strategic_context: "",
      },
    });
    const { deps } = createMockDeps([
      createUsageMessage({ result: "output" }),
    ]);
    vi.mocked(deps.processEvolutionResult).mockReturnValue(processed);
    const db = createMockDb();
    const consoleSpy = vi.spyOn(console, "log");

    await runEvolutionPhase(
      db, 1, createOutcome(), "assessment", "identity", [], deps, createMockSafetyHooks(),
    );

    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    expect(logCalls.some((msg) => typeof msg === "string" && msg.includes("attempted"))).toBe(true);
    expect(logCalls.some((msg) => typeof msg === "string" && msg.includes("succeeded"))).toBe(true);
  });

  it("logs strategic context stored message when strategicContextStored is true", async () => {
    const processed = createProcessedEvolution({ strategicContextStored: true });
    const { deps } = createMockDeps([
      createUsageMessage({ result: "output" }),
    ]);
    vi.mocked(deps.processEvolutionResult).mockReturnValue(processed);
    const db = createMockDb();
    const consoleSpy = vi.spyOn(console, "log");

    await runEvolutionPhase(
      db, 1, createOutcome(), "assessment", "identity", [], deps, createMockSafetyHooks(),
    );

    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    expect(logCalls.some((msg) => typeof msg === "string" && msg.includes("Stored strategic context"))).toBe(true);
  });
});

describe("createDefaultDeps", () => {
  it("creates deps with the given queryFn", () => {
    const { queryFn } = createMockQueryFn([]);
    const deps = createDefaultDeps(queryFn);

    expect(deps.queryFn).toBe(queryFn);
    expect(typeof deps.insertPhaseUsage).toBe("function");
    expect(typeof deps.processEvolutionResult).toBe("function");
  });
});
