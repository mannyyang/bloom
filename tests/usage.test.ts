import { describe, it, expect } from "vitest";
import {
  extractUsage,
  extractResultText,
  aggregateUsage,
  formatPhaseUsage,
  formatCycleUsage,
  formatUsageForJournal,
  formatDurationSec,
  COST_DECIMAL_PLACES,
  PhaseUsage,
} from "../src/usage.js";

describe("extractResultText", () => {
  it("extracts result string from a valid result message", () => {
    expect(extractResultText({ result: "hello" })).toBe("hello");
  });

  it("returns null for a message without result field", () => {
    expect(extractResultText({ type: "progress" })).toBeNull();
  });

  it("returns null when result is not a string", () => {
    expect(extractResultText({ result: 42 })).toBeNull();
  });

  it("returns null for null input", () => {
    expect(extractResultText(null)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(extractResultText("string")).toBeNull();
  });

  it("returns empty string when result is empty string", () => {
    expect(extractResultText({ result: "" })).toBe("");
  });
});

describe("extractUsage", () => {
  it("extracts usage from a valid result message", () => {
    const msg = {
      type: "result",
      subtype: "success",
      total_cost_usd: 1.2345,
      usage: {
        input_tokens: 5000,
        output_tokens: 2000,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
      },
      duration_ms: 30000,
      num_turns: 10,
      result: "done",
    };

    const result = extractUsage(msg, "Assessment");
    expect(result).toEqual({
      phase: "Assessment",
      totalCostUsd: 1.2345,
      inputTokens: 5000,
      outputTokens: 2000,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 500,
      durationMs: 30000,
      numTurns: 10,
    });
  });

  it("returns null for non-object inputs", () => {
    expect(extractUsage(null, "Test")).toBeNull();
    expect(extractUsage(undefined, "Test")).toBeNull();
    expect(extractUsage(42, "Test")).toBeNull();
    expect(extractUsage("string", "Test")).toBeNull();
    expect(extractUsage(true, "Test")).toBeNull();
  });

  it("returns null for non-result messages", () => {
    expect(extractUsage({ type: "stream_event" }, "Test")).toBeNull();
    expect(extractUsage({ type: "system" }, "Test")).toBeNull();
  });

  it("returns null when total_cost_usd is missing", () => {
    expect(extractUsage({ type: "result" }, "Test")).toBeNull();
  });

  it("returns null when total_cost_usd is not a number", () => {
    expect(extractUsage({ type: "result", total_cost_usd: "free" }, "Test")).toBeNull();
  });

  it("defaults missing usage fields to 0", () => {
    const msg = {
      type: "result",
      total_cost_usd: 0.5,
      num_turns: 3,
      duration_ms: 10000,
    };

    const result = extractUsage(msg, "Evolution");
    expect(result).toEqual({
      phase: "Evolution",
      totalCostUsd: 0.5,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      durationMs: 10000,
      numTurns: 3,
    });
  });

  it("defaults non-number usage fields to 0", () => {
    const msg = {
      type: "result",
      total_cost_usd: 0.5,
      usage: {
        input_tokens: "123",       // string, not number
        output_tokens: true,        // boolean, not number
        cache_read_input_tokens: null,
        cache_creation_input_tokens: undefined,
      },
      duration_ms: "fast",          // string, not number
      num_turns: [10],              // array, not number
    };

    const result = extractUsage(msg, "Test");
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(0);
    expect(result!.outputTokens).toBe(0);
    expect(result!.cacheReadInputTokens).toBe(0);
    expect(result!.cacheCreationInputTokens).toBe(0);
    expect(result!.durationMs).toBe(0);
    expect(result!.numTurns).toBe(0);
  });

  it("handles usage field that is not an object", () => {
    const msg = {
      type: "result",
      total_cost_usd: 0.5,
      usage: "not-an-object",
      duration_ms: 1000,
      num_turns: 2,
    };

    const result = extractUsage(msg, "Test");
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(0);
    expect(result!.outputTokens).toBe(0);
    expect(result!.durationMs).toBe(1000);
    expect(result!.numTurns).toBe(2);
  });

  it("handles error result messages", () => {
    const msg = {
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      total_cost_usd: 2.0,
      usage: { input_tokens: 8000, output_tokens: 3000 },
      duration_ms: 60000,
      num_turns: 50,
    };

    const result = extractUsage(msg, "Evolution");
    expect(result).not.toBeNull();
    expect(result!.totalCostUsd).toBe(2.0);
  });

  it("returns PhaseUsage (not null) when total_cost_usd is exactly zero", () => {
    // Zero-cost runs occur during sandbox/cached executions; 0 is still a valid number
    const msg = {
      type: "result",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      duration_ms: 100,
      num_turns: 1,
    };
    const result = extractUsage(msg, "ZeroCost");
    expect(result).not.toBeNull();
    expect(result!.totalCostUsd).toBe(0);
    expect(result!.inputTokens).toBe(0);
    expect(result!.outputTokens).toBe(0);
  });

  it("correctly preserves zero input tokens with non-zero cache tokens (cache-only run)", () => {
    // Cache-heavy cycles: all prompt tokens served from cache, input_tokens=0
    const msg = {
      type: "result",
      total_cost_usd: 0.05,
      usage: {
        input_tokens: 0,
        output_tokens: 300,
        cache_read_input_tokens: 20000,
        cache_creation_input_tokens: 0,
      },
      duration_ms: 8000,
      num_turns: 4,
    };
    const result = extractUsage(msg, "CacheOnly");
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(0);
    expect(result!.cacheReadInputTokens).toBe(20000);
    expect(result!.cacheCreationInputTokens).toBe(0);
    expect(result!.outputTokens).toBe(300);
  });

  it("clamps negative numeric token values to zero (numOrZero guards both non-numbers and negatives)", () => {
    // Negative token counts are semantically impossible; numOrZero clamps them to 0
    // so corrupt SDK output never silently corrupts aggregate cost/token metrics.
    const msg = {
      type: "result",
      total_cost_usd: 0.1,
      usage: { input_tokens: -5, output_tokens: 10 },
      duration_ms: 500,
      num_turns: 1,
    };
    const result = extractUsage(msg, "NegativeTokens");
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(0);
    expect(result!.outputTokens).toBe(10);
  });
});

describe("aggregateUsage", () => {
  const phase1: PhaseUsage = {
    phase: "Assessment",
    totalCostUsd: 1.0,
    inputTokens: 5000,
    outputTokens: 2000,
    cacheReadInputTokens: 500,
    cacheCreationInputTokens: 200,
    durationMs: 20000,
    numTurns: 8,
  };

  const phase2: PhaseUsage = {
    phase: "Evolution",
    totalCostUsd: 3.0,
    inputTokens: 15000,
    outputTokens: 8000,
    cacheReadInputTokens: 3000,
    cacheCreationInputTokens: 1000,
    durationMs: 60000,
    numTurns: 30,
  };

  it("aggregates multiple phases", () => {
    const result = aggregateUsage([phase1, phase2]);
    expect(result.totalCostUsd).toBe(4.0);
    expect(result.totalInputTokens).toBe(20000);
    expect(result.totalOutputTokens).toBe(10000);
    expect(result.phases).toHaveLength(2);
  });

  it("handles empty phases array", () => {
    const result = aggregateUsage([]);
    expect(result.totalCostUsd).toBe(0);
    expect(result.totalInputTokens).toBe(0);
    expect(result.totalOutputTokens).toBe(0);
    expect(result.phases).toHaveLength(0);
  });

  it("handles a single phase", () => {
    const result = aggregateUsage([phase1]);
    expect(result.totalCostUsd).toBe(1.0);
    expect(result.totalInputTokens).toBe(5000);
    expect(result.totalOutputTokens).toBe(2000);
  });

  it("aggregates cache token fields correctly", () => {
    const result = aggregateUsage([phase1, phase2]);
    expect(result.totalCacheReadTokens).toBe(3500); // 500 + 3000
    expect(result.totalCacheCreationTokens).toBe(1200); // 200 + 1000
  });

  it("returns zero cache tokens for phases with no cache usage", () => {
    const noCache: PhaseUsage = {
      phase: "Test",
      totalCostUsd: 0.5,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      durationMs: 1000,
      numTurns: 1,
    };
    const result = aggregateUsage([noCache]);
    expect(result.totalCacheReadTokens).toBe(0);
    expect(result.totalCacheCreationTokens).toBe(0);
  });

  it("aggregates an all-zero phase without producing NaN", () => {
    const zeroCost: PhaseUsage = {
      phase: "ZeroPhase",
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      durationMs: 0,
      numTurns: 0,
    };
    const result = aggregateUsage([zeroCost]);
    expect(result.totalCostUsd).toBe(0);
    expect(result.totalInputTokens).toBe(0);
    expect(result.totalOutputTokens).toBe(0);
    expect(result.totalCacheReadTokens).toBe(0);
    expect(result.totalCacheCreationTokens).toBe(0);
    // Verify no NaN leaked in
    expect(Number.isNaN(result.totalCostUsd)).toBe(false);
  });

  it("aggregates a cache-only phase (zero input, non-zero cache read)", () => {
    const cacheOnly: PhaseUsage = {
      phase: "CacheHeavy",
      totalCostUsd: 0.02,
      inputTokens: 0,
      outputTokens: 150,
      cacheReadInputTokens: 30000,
      cacheCreationInputTokens: 0,
      durationMs: 3000,
      numTurns: 2,
    };
    const result = aggregateUsage([cacheOnly]);
    expect(result.totalInputTokens).toBe(0);
    expect(result.totalCacheReadTokens).toBe(30000);
    expect(result.totalCacheCreationTokens).toBe(0);
  });
});

describe("formatPhaseUsage", () => {
  it("formats a phase usage into a readable line", () => {
    const pu: PhaseUsage = {
      phase: "Assessment",
      totalCostUsd: 1.2345,
      inputTokens: 5000,
      outputTokens: 2000,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 200,
      durationMs: 30000,
      numTurns: 10,
    };

    const line = formatPhaseUsage(pu);
    expect(line).toContain("[Assessment]");
    expect(line).toContain("$1.2345");
    expect(line).toContain("5,000 in");
    expect(line).toContain("2,000 out");
    expect(line).toContain("Turns: 10");
    expect(line).toContain("30.0s");
  });
});

describe("formatCycleUsage", () => {
  it("formats a full cycle summary with total line", () => {
    const cu = aggregateUsage([
      {
        phase: "Assessment",
        totalCostUsd: 1.0,
        inputTokens: 5000,
        outputTokens: 2000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        durationMs: 20000,
        numTurns: 8,
      },
      {
        phase: "Evolution",
        totalCostUsd: 3.0,
        inputTokens: 15000,
        outputTokens: 8000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        durationMs: 60000,
        numTurns: 30,
      },
    ]);

    const output = formatCycleUsage(cu);
    const lines = output.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("[Assessment]");
    expect(lines[1]).toContain("[Evolution]");
    expect(lines[2]).toContain("[Total]");
    expect(lines[2]).toContain("$4.0000");
  });

  it("includes cache suffix when cache tokens are non-zero", () => {
    const cu = aggregateUsage([
      {
        phase: "Assessment",
        totalCostUsd: 1.0,
        inputTokens: 5000,
        outputTokens: 2000,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 500,
        durationMs: 20000,
        numTurns: 8,
      },
    ]);

    const output = formatCycleUsage(cu);
    const totalLine = output.split("\n").find(l => l.includes("[Total]"))!;
    expect(totalLine).toContain("Cache:");
    expect(totalLine).toContain("read");
    expect(totalLine).toContain("created");
  });

  it("omits cache suffix when all cache tokens are zero", () => {
    const cu = aggregateUsage([
      {
        phase: "Test",
        totalCostUsd: 0.5,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        durationMs: 1000,
        numTurns: 1,
      },
    ]);

    const output = formatCycleUsage(cu);
    expect(output).not.toContain("Cache:");
  });

  it("produces just a Total line when there are zero phases", () => {
    const cu = aggregateUsage([]);
    const output = formatCycleUsage(cu);
    const lines = output.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[Total]");
    expect(lines[0]).toContain("$0.0000");
  });
});

describe("formatUsageForJournal", () => {
  it("formats usage as a markdown section", () => {
    const cu = aggregateUsage([
      {
        phase: "Assessment",
        totalCostUsd: 1.5,
        inputTokens: 5000,
        outputTokens: 2000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        durationMs: 20000,
        numTurns: 8,
      },
    ]);

    const md = formatUsageForJournal(cu);
    expect(md).toContain("### Resource Usage");
    expect(md).toContain("**Assessment**");
    expect(md).toContain("$1.5000");
    expect(md).toContain("**Total**");
  });

  it("includes per-phase duration in journal format", () => {
    const cu = aggregateUsage([
      {
        phase: "Assessment",
        totalCostUsd: 1.0,
        inputTokens: 5000,
        outputTokens: 2000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        durationMs: 30000,
        numTurns: 10,
      },
    ]);

    const md = formatUsageForJournal(cu);
    const phaseLine = md.split("\n").find((l) => l.includes("**Assessment**"))!;
    expect(phaseLine).toContain("30.0s");
  });

  it("includes cache suffix when cache tokens are non-zero", () => {
    const cu = aggregateUsage([
      {
        phase: "Evolution",
        totalCostUsd: 2.0,
        inputTokens: 10000,
        outputTokens: 5000,
        cacheReadInputTokens: 3000,
        cacheCreationInputTokens: 1500,
        durationMs: 40000,
        numTurns: 15,
      },
    ]);

    const md = formatUsageForJournal(cu);
    expect(md).toContain("cache:");
    expect(md).toContain("read");
    expect(md).toContain("created");
  });

  it("omits cache suffix when all cache tokens are zero", () => {
    const cu = aggregateUsage([
      {
        phase: "Assessment",
        totalCostUsd: 0.5,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        durationMs: 5000,
        numTurns: 3,
      },
    ]);

    const md = formatUsageForJournal(cu);
    expect(md).not.toContain("cache:");
  });

  it("produces a well-formed markdown block with zero phases", () => {
    const cu = aggregateUsage([]);
    const md = formatUsageForJournal(cu);
    // Header must be present
    expect(md).toContain("### Resource Usage");
    // Total line must be present with all-zero cost
    expect(md).toContain("**Total**");
    expect(md).toContain("$0.0000");
    // No individual phase lines should appear
    const lines = md.split("\n");
    const phaseLines = lines.filter(
      (l) => l.startsWith("- **") && !l.includes("**Total**"),
    );
    expect(phaseLines).toHaveLength(0);
  });
});

describe("formatDurationSec", () => {
  it("formats milliseconds as seconds with one decimal", () => {
    expect(formatDurationSec(1234)).toBe("1.2s");
  });

  it("formats zero", () => {
    expect(formatDurationSec(0)).toBe("0.0s");
  });

  it("formats exact seconds", () => {
    expect(formatDurationSec(5000)).toBe("5.0s");
  });

  it("rounds correctly", () => {
    expect(formatDurationSec(1450)).toBe("1.4s");
    expect(formatDurationSec(1460)).toBe("1.5s");
  });

  it("handles large values", () => {
    expect(formatDurationSec(123456)).toBe("123.5s");
  });
});

describe("COST_DECIMAL_PLACES", () => {
  it("is pinned to 4 for sub-cent precision in cost reporting", () => {
    expect(COST_DECIMAL_PLACES).toBe(4);
  });

  it("formatPhaseUsage uses COST_DECIMAL_PLACES decimal places for cost", () => {
    const pu: PhaseUsage = {
      phase: "test",
      totalCostUsd: 1.23456789,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      durationMs: 1000,
      numTurns: 5,
    };
    const formatted = formatPhaseUsage(pu);
    expect(formatted).toContain(`$${(1.23456789).toFixed(COST_DECIMAL_PLACES)}`);
  });
});
