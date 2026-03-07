import { describe, it, expect } from "vitest";
import { buildAssessmentPrompt, buildEvolutionPrompt, parseEvolutionResult, countImprovements } from "../src/evolve.js";

describe("buildAssessmentPrompt", () => {
  it("includes identity and cycle count", () => {
    const prompt = buildAssessmentPrompt({
      identity: "I am Bloom",
      journalSummary: "# Journal",
      issues: [],
      cycleCount: 5,
    });
    expect(prompt).toContain("evolution cycle 5");
    expect(prompt).toContain("I am Bloom");
  });

  it("includes community issues sorted by reactions", () => {
    const prompt = buildAssessmentPrompt({
      identity: "test",
      journalSummary: "",
      issues: [
        { number: 1, title: "Add feature X", body: "", reactions: 10 },
        { number: 2, title: "Fix bug Y", body: "", reactions: 5 },
      ],
      cycleCount: 1,
    });
    expect(prompt).toContain("#1: Add feature X (10 reactions)");
    expect(prompt).toContain("#2: Fix bug Y (5 reactions)");
  });

  it("handles no issues gracefully", () => {
    const prompt = buildAssessmentPrompt({
      identity: "test",
      journalSummary: "",
      issues: [],
      cycleCount: 1,
    });
    expect(prompt).toContain("No community issues");
  });

  it("includes journal summary in prompt", () => {
    const prompt = buildAssessmentPrompt({
      identity: "test",
      journalSummary: "## Cycle 5 — 2026-03-06\nSome content here",
      issues: [],
      cycleCount: 6,
    });
    expect(prompt).toContain("Cycle 5");
    expect(prompt).toContain("Some content here");
  });
});

describe("buildEvolutionPrompt", () => {
  it("includes the assessment and rules", () => {
    const prompt = buildEvolutionPrompt("Improve error handling in utils.ts");
    expect(prompt).toContain("Improve error handling in utils.ts");
    expect(prompt).toContain("pnpm build && pnpm test");
    expect(prompt).toContain("NEVER modify IDENTITY.md");
  });

  it("instructs agent not to write JOURNAL.md", () => {
    const prompt = buildEvolutionPrompt("assessment");
    expect(prompt).toContain("Do NOT write to JOURNAL.md");
  });

  it("instructs agent to provide structured summary", () => {
    const prompt = buildEvolutionPrompt("assessment");
    expect(prompt).toContain("ATTEMPTED:");
    expect(prompt).toContain("SUCCEEDED:");
    expect(prompt).toContain("FAILED:");
    expect(prompt).toContain("LEARNINGS:");
  });

  it("includes usage context when provided", () => {
    const prompt = buildEvolutionPrompt("assessment text", { usageContext: "Cost: $0.50" });
    expect(prompt).toContain("Resource usage so far this cycle:");
    expect(prompt).toContain("Cost: $0.50");
  });

  it("omits usage section when no context provided", () => {
    const prompt = buildEvolutionPrompt("assessment text");
    expect(prompt).not.toContain("Resource usage");
  });

  it("includes outcome context when provided", () => {
    const prompt = buildEvolutionPrompt("assessment text", { outcomeContext: "Preflight: passed" });
    expect(prompt).toContain("Cycle outcome metrics so far:");
    expect(prompt).toContain("Preflight: passed");
  });

  it("includes both usage and outcome context together", () => {
    const prompt = buildEvolutionPrompt("assessment text", {
      usageContext: "Cost: $0.50",
      outcomeContext: "Preflight: passed",
    });
    expect(prompt).toContain("Resource usage so far this cycle:");
    expect(prompt).toContain("Cycle outcome metrics so far:");
  });
});

describe("parseEvolutionResult", () => {
  it("parses all four sections with plain markers", () => {
    const input = `ATTEMPTED: Added new feature
- Item 1
SUCCEEDED: Feature works
- It passed
FAILED: Nothing failed
LEARNINGS: Learned a lot`;
    const result = parseEvolutionResult(input);
    expect(result.attempted).toContain("Added new feature");
    expect(result.attempted).toContain("- Item 1");
    expect(result.succeeded).toContain("Feature works");
    expect(result.failed).toContain("Nothing failed");
    expect(result.learnings).toContain("Learned a lot");
  });

  it("parses bold markers like **ATTEMPTED**:", () => {
    const input = `**ATTEMPTED**: Bold attempt
**SUCCEEDED**: Bold success`;
    const result = parseEvolutionResult(input);
    expect(result.attempted).toContain("Bold attempt");
    expect(result.succeeded).toContain("Bold success");
  });

  it("returns empty strings for missing sections", () => {
    const result = parseEvolutionResult("Just some random text");
    expect(result.attempted).toBe("");
    expect(result.succeeded).toBe("");
    expect(result.failed).toBe("");
    expect(result.learnings).toBe("");
  });

  it("handles empty input", () => {
    const result = parseEvolutionResult("");
    expect(result.attempted).toBe("");
  });

  it("collects multiline content under correct section", () => {
    const input = `ATTEMPTED: First line
- Detail 1
- Detail 2
Some more context
SUCCEEDED: Done`;
    const result = parseEvolutionResult(input);
    expect(result.attempted).toContain("- Detail 1");
    expect(result.attempted).toContain("- Detail 2");
    expect(result.attempted).toContain("Some more context");
    expect(result.succeeded).toContain("Done");
  });

  it("handles content on same line as marker", () => {
    const input = "ATTEMPTED: inline content here";
    const result = parseEvolutionResult(input);
    expect(result.attempted).toBe("inline content here");
  });

  it("handles marker with no content after colon", () => {
    const input = `ATTEMPTED:
- Item below`;
    const result = parseEvolutionResult(input);
    expect(result.attempted).toContain("- Item below");
  });

  it("handles interleaved non-section text before first marker", () => {
    const input = `Some preamble text
More preamble
ATTEMPTED: The actual content`;
    const result = parseEvolutionResult(input);
    expect(result.attempted).toBe("The actual content");
  });
});

describe("countImprovements", () => {
  it("counts bullet items starting with dash", () => {
    expect(countImprovements("- Item 1\n- Item 2\n- Item 3")).toBe(3);
  });

  it("counts numbered items", () => {
    expect(countImprovements("1. First\n2. Second")).toBe(2);
  });

  it("counts mixed bullets and numbers", () => {
    expect(countImprovements("- Item A\n1. Item B\n- Item C")).toBe(3);
  });

  it("returns 0 for empty string", () => {
    expect(countImprovements("")).toBe(0);
  });

  it("ignores plain text lines", () => {
    expect(countImprovements("Just some text\nMore text")).toBe(0);
  });

  it("handles indented bullets", () => {
    expect(countImprovements("  - Indented item\n  1. Another")).toBe(2);
  });
});
