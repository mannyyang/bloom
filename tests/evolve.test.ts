import { describe, it, expect } from "vitest";
import { buildAssessmentPrompt, buildEvolutionPrompt } from "../src/evolve.js";

describe("buildAssessmentPrompt", () => {
  it("includes identity and day count", () => {
    const prompt = buildAssessmentPrompt({
      identity: "I am Bloom",
      journal: "# Journal",
      issues: [],
      dayCount: 5,
    });
    expect(prompt).toContain("evolution day 5");
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
      dayCount: 1,
    });
    expect(prompt).toContain("#1: Add feature X (10 reactions)");
    expect(prompt).toContain("#2: Fix bug Y (5 reactions)");
  });

  it("handles no issues gracefully", () => {
    const prompt = buildAssessmentPrompt({
      identity: "test",
      journal: "",
      issues: [],
      dayCount: 1,
    });
    expect(prompt).toContain("No community issues");
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
