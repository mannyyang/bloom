import { describe, it, expect } from "vitest";
import { buildAssessmentPrompt, buildEvolutionPrompt } from "../src/evolve.js";

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
