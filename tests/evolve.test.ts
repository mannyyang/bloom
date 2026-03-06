import { describe, it, expect } from "vitest";
import { buildAssessmentPrompt, buildEvolutionPrompt } from "../src/evolve.js";

describe("buildAssessmentPrompt", () => {
  it("includes identity and cycle count", () => {
    const prompt = buildAssessmentPrompt({
      identity: "I am Bloom",
      journal: "# Journal",
      issues: [],
      cycleCount: 5,
    });
    expect(prompt).toContain("evolution cycle 5");
    expect(prompt).toContain("I am Bloom");
  });

  it("includes community issues sorted by reactions", () => {
    const prompt = buildAssessmentPrompt({
      identity: "test",
      journal: "",
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
      journal: "",
      issues: [],
      cycleCount: 1,
    });
    expect(prompt).toContain("No community issues");
  });

  it("truncates a long journal at a line boundary", () => {
    // Build a journal longer than 2000 chars with clear line structure.
    const line = "x".repeat(100) + "\n";
    const longJournal = line.repeat(25); // 2525 chars total
    const prompt = buildAssessmentPrompt({
      identity: "test",
      journal: longJournal,
      issues: [],
      cycleCount: 1,
    });
    // Extract the journal section from the prompt.
    const marker = "Recent journal entries:\n";
    const start = prompt.indexOf(marker) + marker.length;
    const end = prompt.indexOf("\n\nRead all files");
    const journalSection = prompt.slice(start, end);
    // Newest-first: truncated from front, so must end at a line boundary.
    expect(journalSection.endsWith("x".repeat(100))).toBe(true);
  });
});

describe("buildEvolutionPrompt", () => {
  it("includes the assessment and rules", () => {
    const prompt = buildEvolutionPrompt("Improve error handling in utils.ts");
    expect(prompt).toContain("Improve error handling in utils.ts");
    expect(prompt).toContain("pnpm build && pnpm test");
    expect(prompt).toContain("NEVER modify IDENTITY.md");
  });
});
