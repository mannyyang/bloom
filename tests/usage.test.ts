import { describe, it, expect } from "vitest";
import {
  extractUsage,
  aggregateUsage,
  formatPhaseUsage,
  formatCycleUsage,
  formatUsageForJournal,
  PhaseUsage,
} from "../src/usage.js";

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
});
