import { describe, it, expect } from "vitest";
import { buildAssessmentPrompt, buildEvolutionPrompt, parseEvolutionResult, countImprovements } from "../src/evolve.js";

describe("buildAssessmentPrompt", () => {
  it("includes cycle count in prompt", () => {
    const prompt = buildAssessmentPrompt({
      journalSummary: "# Journal",
      cycleCount: 5,
    });
    expect(prompt).toContain("evolution cycle 5");
  });

  it("references roadmap for community work", () => {
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 1,
    });
    expect(prompt).toContain("roadmap");
  });

  it("always includes 'Recent journal entries:' header even with empty summary", () => {
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 1,
    });
    expect(prompt).toContain("Recent journal entries:");
  });

  it("includes cycleStatsText in prompt when provided", () => {
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 10,
      cycleStatsText: "Total cycles: 9 | Success rate: 78%",
    });
    expect(prompt).toContain("track record");
    expect(prompt).toContain("Total cycles: 9 | Success rate: 78%");
  });

  it("omits track record section when cycleStatsText is absent", () => {
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 10,
    });
    expect(prompt).not.toContain("track record");
  });

  it("includes memoryContext when provided", () => {
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 5,
      memoryContext: "[pattern] Always run tests before committing",
    });
    expect(prompt).toContain("accumulated knowledge");
    expect(prompt).toContain("[pattern] Always run tests before committing");
  });

  it("omits memory section when memoryContext is absent", () => {
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 5,
    });
    expect(prompt).not.toContain("accumulated knowledge");
  });

  it("includes planningContext when provided", () => {
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 5,
      planningContext: "Current item: Improve error handling",
    });
    expect(prompt).toContain("Current item: Improve error handling");
  });

  it("omits planning section when planningContext is absent", () => {
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 5,
    });
    expect(prompt).not.toContain("Current item");
  });

  it("includes journal summary in prompt", () => {
    const prompt = buildAssessmentPrompt({
      journalSummary: "## Cycle 5 — 2026-03-06\nSome content here",
      cycleCount: 6,
    });
    expect(prompt).toContain("Cycle 5");
    expect(prompt).toContain("Some content here");
  });

  it("instructs assessment to stay under 2000 characters for efficiency", () => {
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 1,
    });
    expect(prompt).toContain("under 2000 characters");
    expect(prompt).toContain("passed directly into the implementation prompt");
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

  it("LEARNINGS section shows bullet-list format so extractLearnings can parse it", () => {
    const prompt = buildEvolutionPrompt("assessment");
    // extractLearnings requires lines starting with -, *, or digit.
    // The prompt must model this so the agent produces parseable output.
    const learningsIdx = prompt.indexOf("LEARNINGS:");
    expect(learningsIdx).toBeGreaterThan(-1);
    const afterLearnings = prompt.slice(learningsIdx);
    expect(afterLearnings).toMatch(/LEARNINGS:\s*\n-\s+/);
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

  it("instructs agent to update README and documentation", () => {
    const prompt = buildEvolutionPrompt("assessment");
    expect(prompt).toContain("README.md");
    expect(prompt).toContain("public-facing documentation");
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

  it("parses bold markers with colon inside like **ATTEMPTED:**", () => {
    const input = `**ATTEMPTED:** Three improvements
1. First thing
**SUCCEEDED:** All worked
**FAILED:** Nothing
**LEARNINGS:** Key insight`;
    const result = parseEvolutionResult(input);
    expect(result.attempted).toContain("Three improvements");
    expect(result.attempted).toContain("1. First thing");
    expect(result.succeeded).toContain("All worked");
    expect(result.failed).toContain("Nothing");
    expect(result.learnings).toContain("Key insight");
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

  it("parses markdown header format like ## ATTEMPTED", () => {
    const input = `## ATTEMPTED
1. Added new feature
2. Fixed a bug
## SUCCEEDED
Both worked
## FAILED
Nothing failed
## LEARNINGS
Learned things`;
    const result = parseEvolutionResult(input);
    expect(result.attempted).toContain("1. Added new feature");
    expect(result.attempted).toContain("2. Fixed a bug");
    expect(result.succeeded).toContain("Both worked");
    expect(result.failed).toContain("Nothing failed");
    expect(result.learnings).toContain("Learned things");
  });

  it("parses markdown header with bold like ## **ATTEMPTED**", () => {
    const input = `## **ATTEMPTED**
Tried something
## **SUCCEEDED**
It worked`;
    const result = parseEvolutionResult(input);
    expect(result.attempted).toContain("Tried something");
    expect(result.succeeded).toContain("It worked");
  });

  it("parses dash-prefix format like - ATTEMPTED:", () => {
    const input = `- ATTEMPTED: Dash prefix attempt
- SUCCEEDED: Dash prefix success
- FAILED: Nothing
- LEARNINGS: Dash works`;
    const result = parseEvolutionResult(input);
    expect(result.attempted).toContain("Dash prefix attempt");
    expect(result.succeeded).toContain("Dash prefix success");
    expect(result.failed).toContain("Nothing");
    expect(result.learnings).toContain("Dash works");
  });

  it("parses STRATEGIC_CONTEXT with inline content", () => {
    const input = "STRATEGIC_CONTEXT: Focusing on test coverage and reliability.";
    const result = parseEvolutionResult(input);
    expect(result.strategic_context).toBe("Focusing on test coverage and reliability.");
  });

  it("parses STRATEGIC_CONTEXT with content on following lines", () => {
    const input = `STRATEGIC_CONTEXT:
Building towards better error handling.
Also improving test coverage.`;
    const result = parseEvolutionResult(input);
    expect(result.strategic_context).toContain("Building towards better error handling.");
    expect(result.strategic_context).toContain("Also improving test coverage.");
  });

  it("parses **STRATEGIC_CONTEXT**: bold format", () => {
    const input = "**STRATEGIC_CONTEXT**: Bold strategic context here.";
    const result = parseEvolutionResult(input);
    expect(result.strategic_context).toBe("Bold strategic context here.");
  });

  it("parses STRATEGIC_CONTEXT alongside other sections", () => {
    const input = `ATTEMPTED: Fix regex bug
SUCCEEDED: Regex fixed
FAILED: Nothing
LEARNINGS: [pattern] Always test with underscores
STRATEGIC_CONTEXT: Focusing on parsing robustness.`;
    const result = parseEvolutionResult(input);
    expect(result.attempted).toContain("Fix regex bug");
    expect(result.succeeded).toContain("Regex fixed");
    expect(result.failed).toContain("Nothing");
    expect(result.learnings).toContain("[pattern] Always test with underscores");
    expect(result.strategic_context).toBe("Focusing on parsing robustness.");
  });

  it("correctly parses all fields when sections appear in non-standard order", () => {
    // Sections shuffled: LEARNINGS first, then FAILED, STRATEGIC_CONTEXT, SUCCEEDED, ATTEMPTED last
    const input = `LEARNINGS: Key insight first
FAILED: One thing broke
STRATEGIC_CONTEXT: Focused on stability.
SUCCEEDED: Two things worked
ATTEMPTED: Three improvements tried`;
    const result = parseEvolutionResult(input);
    expect(result.learnings).toContain("Key insight first");
    expect(result.failed).toContain("One thing broke");
    expect(result.strategic_context).toContain("Focused on stability.");
    expect(result.succeeded).toContain("Two things worked");
    expect(result.attempted).toContain("Three improvements tried");
  });

  it("captures inline content on header line when followed by another section", () => {
    // Real LLM output pattern: "ATTEMPTED: Added logging\nSUCCEEDED: yes"
    // The `rest` capture on the ATTEMPTED line must populate attempted, not be lost.
    const input = "ATTEMPTED: Added logging\nSUCCEEDED: yes";
    const result = parseEvolutionResult(input);
    expect(result.attempted).toBe("Added logging");
    expect(result.succeeded).toBe("yes");
  });

  it("returns empty strategic_context for completely unmarked prose", () => {
    // Regression: the existing "returns empty strings for missing sections" test
    // checked attempted/succeeded/failed/learnings but not strategic_context.
    const result = parseEvolutionResult("Just some random text with no section headers at all.");
    expect(result.attempted).toBe("");
    expect(result.succeeded).toBe("");
    expect(result.failed).toBe("");
    expect(result.learnings).toBe("");
    expect(result.strategic_context).toBe("");
  });

  it("handles section marker at EOF with no trailing newline and no inline content", () => {
    // LLM failure mode: section header appears as the very last token, no newline after.
    // countImprovements() reads from succeeded/failed — this must not throw or return undefined.
    const input = "ATTEMPTED: Added logging\nSUCCEEDED:";
    const result = parseEvolutionResult(input);
    expect(result.attempted).toBe("Added logging");
    expect(result.succeeded).toBe("");
    expect(result.failed).toBe("");
    expect(result.strategic_context).toBe("");
  });

  it("parses triple-hash header format like ### ATTEMPTED identically to ## ATTEMPTED", () => {
    const input = `### ATTEMPTED
- Triple-hash attempt
### SUCCEEDED
Triple-hash success
### FAILED
nothing
### LEARNINGS
Triple-hash learning`;
    const result = parseEvolutionResult(input);
    expect(result.attempted).toContain("- Triple-hash attempt");
    expect(result.succeeded).toContain("Triple-hash success");
    expect(result.failed).toContain("nothing");
    expect(result.learnings).toContain("Triple-hash learning");
  });

  it("does not parse triple-asterisk headers (***ATTEMPTED***) — HEADER_RE only allows 0-2 asterisks", () => {
    // ***KEYWORD*** is markdown bold+italic; HEADER_RE uses \*{0,2} which intentionally
    // does not match three asterisks.  Content under such a header is silently skipped
    // (no section becomes active).  This test documents and locks in that behaviour.
    const input = `***ATTEMPTED***: tried triple bold+italic header
Some content here
***SUCCEEDED***: also triple
This content too`;
    const result = parseEvolutionResult(input);
    expect(result.attempted).toBe("");
    expect(result.succeeded).toBe("");
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

  it("counts N) format on separate lines", () => {
    expect(countImprovements("1) First\n2) Second\n3) Third")).toBe(3);
  });

  it("counts inline numbered items with N) format", () => {
    expect(countImprovements("1) Include strategic_context. 2) Add cache tokens. 3) Remove fallback.")).toBe(3);
  });

  it("counts inline numbered items with N. format", () => {
    expect(countImprovements("1. First item, 2. second item, 3. third item")).toBe(3);
  });

  it("counts inline items preceded by prose", () => {
    expect(countImprovements("All three succeeded. 1) Added field. 2) Updated usage. 3) Removed fallback.")).toBe(3);
  });

  it("counts bullet items starting with asterisk", () => {
    expect(countImprovements("* Item 1\n* Item 2\n* Item 3")).toBe(3);
  });

  it("counts mixed asterisk and dash bullets", () => {
    expect(countImprovements("* Item A\n- Item B\n* Item C")).toBe(3);
  });

  it("does not count horizontal rules or bare dashes as improvements", () => {
    expect(countImprovements("---")).toBe(0);
    expect(countImprovements("---\nSome text\n---")).toBe(0);
    expect(countImprovements("-something without space")).toBe(0);
  });

  it("returns 0 for whitespace-only string", () => {
    expect(countImprovements("   ")).toBe(0);
    expect(countImprovements("   \n  ")).toBe(0);
  });

  it("counts single-line inline items with N) format (falls through to Math.max)", () => {
    // Single-line input: lineCount=1 (first "1) " at start), nonEmptyLines=1,
    // so lineCount > 0 && nonEmptyLines > 1 is false → Math.max(1, 2) = 2
    expect(countImprovements("1) foo. 2) bar.")).toBe(2);
  });

  it("prefers line count over inline count on multi-line input", () => {
    // lineCount = 2 (lines "1) First" and "2) Second." each start with "N) ")
    // inlineCount = 3 but multi-line input with lineCount > 0 returns lineCount
    // to avoid prose back-references like "3) Inline" inflating the total.
    expect(countImprovements("1) First\n2) Second. 3) Inline")).toBe(2);
  });
});

