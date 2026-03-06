import { describe, it, expect } from "vitest";
import { buildAssessmentPrompt, buildEvolutionPrompt, truncateJournal } from "../src/evolve.js";

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

describe("truncateJournal", () => {
  it("returns empty string unchanged", () => {
    expect(truncateJournal("")).toBe("");
  });

  it("returns short string unchanged", () => {
    expect(truncateJournal("hello\nworld")).toBe("hello\nworld");
  });

  it("returns string exactly at maxLength unchanged", () => {
    const s = "a".repeat(100);
    expect(truncateJournal(s, 100)).toBe(s);
  });

  it("truncates at last newline when over maxLength", () => {
    const s = "abcde\nfghij\nklmno";
    // maxLength=12 => raw="abcde\nfghij\n", lastNewline=11 => "abcde\nfghij"
    expect(truncateJournal(s, 12)).toBe("abcde\nfghij");
  });

  it("returns raw slice when no newline found in truncated portion", () => {
    const s = "a".repeat(200);
    expect(truncateJournal(s, 100)).toBe("a".repeat(100));
  });

  it("respects custom maxLength parameter", () => {
    const s = "line1\nline2\nline3\nline4";
    // maxLength=11 => raw="line1\nline2", lastNewline=5 => "line1"
    expect(truncateJournal(s, 11)).toBe("line1");
  });

  it("uses default JOURNAL_WINDOW (4000) when maxLength not provided", () => {
    const s = "x\n".repeat(2500); // 5000 chars
    const result = truncateJournal(s);
    expect(result.length).toBeLessThanOrEqual(4000);
    expect(result.length).toBeGreaterThan(0);
    // Should end at a line boundary (on "x", not "\n")
    expect(result.endsWith("x")).toBe(true);
  });

  it("handles single newline at position 0 by returning raw slice", () => {
    // "\n" + "a"*200 => raw at maxLength 50 = "\n" + "a"*49, lastNewline=0, 0 is not > 0 so fallback
    const s = "\n" + "a".repeat(200);
    expect(truncateJournal(s, 50)).toBe("\n" + "a".repeat(49));
  });
});

describe("buildEvolutionPrompt", () => {
  it("includes the assessment and rules", () => {
    const prompt = buildEvolutionPrompt("Improve error handling in utils.ts");
    expect(prompt).toContain("Improve error handling in utils.ts");
    expect(prompt).toContain("pnpm build && pnpm test");
    expect(prompt).toContain("NEVER modify IDENTITY.md");
  });

  it("includes usage context when provided", () => {
    const prompt = buildEvolutionPrompt("assessment text", "Cost: $0.50");
    expect(prompt).toContain("Resource usage so far this cycle:");
    expect(prompt).toContain("Cost: $0.50");
  });

  it("omits usage section when no context provided", () => {
    const prompt = buildEvolutionPrompt("assessment text");
    expect(prompt).not.toContain("Resource usage");
  });

  it("omits usage section when context is undefined", () => {
    const prompt = buildEvolutionPrompt("assessment text", undefined);
    expect(prompt).not.toContain("Resource usage");
  });
});
