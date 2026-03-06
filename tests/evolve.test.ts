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

  it("returns a short journal unchanged (no trimming of final line)", () => {
    // A journal shorter than JOURNAL_WINDOW that does NOT end with \n.
    const shortJournal = "line1\nline2";
    const prompt = buildAssessmentPrompt({
      identity: "test",
      journal: shortJournal,
      issues: [],
      cycleCount: 1,
    });
    // The full journal must appear in the prompt — "line2" must not be dropped.
    expect(prompt).toContain("line1\nline2");
  });

  it("truncates a long journal without newlines to exactly JOURNAL_WINDOW chars", () => {
    // Build a journal >4000 chars with NO newlines to exercise the fallback path
    const noNewlineJournal = "x".repeat(5000);
    const prompt = buildAssessmentPrompt({
      identity: "test",
      journal: noNewlineJournal,
      issues: [],
      cycleCount: 1,
    });
    const marker = "Recent journal entries:\n";
    const start = prompt.indexOf(marker) + marker.length;
    const end = prompt.indexOf("\n\nRead all files");
    const journalSection = prompt.slice(start, end);
    // Without newlines, the fallback returns the raw 4000-char slice
    expect(journalSection).toBe("x".repeat(4000));
  });

  it("truncates a journal of many short lines at a line boundary", () => {
    // Many 2-char lines ("a\n") totaling > 4000 chars
    const shortLine = "a\n";
    const longJournal = shortLine.repeat(2400); // 4800 chars
    const prompt = buildAssessmentPrompt({
      identity: "test",
      journal: longJournal,
      issues: [],
      cycleCount: 1,
    });
    const marker = "Recent journal entries:\n";
    const start = prompt.indexOf(marker) + marker.length;
    const end = prompt.indexOf("\n\nRead all files");
    const journalSection = prompt.slice(start, end);
    // Should be truncated at a newline boundary, so length is even (each line = "a\n" = 2 chars)
    // Last char of the kept section should be "a" (the newline was the boundary)
    expect(journalSection.length).toBeLessThanOrEqual(4000);
    expect(journalSection.length).toBeGreaterThan(0);
    expect(journalSection.endsWith("a")).toBe(true);
  });

  it("truncates a long journal at a line boundary", () => {
    // Build a journal longer than 4000 chars with clear line structure.
    const line = "x".repeat(100) + "\n";
    const longJournal = line.repeat(50); // 5050 chars total
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
