import { describe, it, expect, vi } from "vitest";
import { buildAssessmentPrompt, buildEvolutionPrompt, parseEvolutionResult, countImprovements, buildFileManifest, ASSESSMENT_CHAR_LIMIT, MANIFEST_DIRS } from "../src/evolve.js";
import { CONTEXT_JOURNAL_MAX_CHARS } from "../src/context.js";

describe("CONTEXT_JOURNAL_MAX_CHARS", () => {
  it("is 1200 (value-pinning)", () => {
    expect(CONTEXT_JOURNAL_MAX_CHARS).toBe(1200);
  });
});

describe("ASSESSMENT_CHAR_LIMIT", () => {
  it("is 2000 (value-pinning)", () => {
    expect(ASSESSMENT_CHAR_LIMIT).toBe(2000);
  });

  it("is interpolated into the assessment prompt", () => {
    const prompt = buildAssessmentPrompt({ journalSummary: "", cycleCount: 1 });
    expect(prompt).toContain("2000 characters");
  });
});

describe("MANIFEST_DIRS", () => {
  it("contains exactly src, tests, and scripts (value-pin)", () => {
    // Pins the exact set of directories scanned by buildFileManifest.
    // If a directory is silently added or removed, this test catches the
    // regression immediately rather than letting it degrade the agent's
    // codebase awareness.
    expect(MANIFEST_DIRS).toEqual(["src", "tests", "scripts"]);
  });

  it("has exactly 3 entries", () => {
    expect(MANIFEST_DIRS).toHaveLength(3);
  });
});

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

  it("instructs LLM to read scripts/ in addition to src/ and tests/", () => {
    // buildFileManifest includes scripts/ in its directory list — the prompt
    // must mention it so the LLM knows to review that directory too.
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 1,
    });
    expect(prompt).toContain("scripts/");
  });

  it("fileManifest header tells LLM not to Glob scripts/ either", () => {
    // The manifest header must cover all three dirs so the LLM does not make
    // redundant Glob calls for any directory already included in the manifest.
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 1,
      fileManifest: "src/evolve.ts\nscripts/memory.ts",
    });
    expect(prompt).toContain("scripts/");
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

  it("omits track record section when cycleStatsText is empty string", () => {
    // Empty string is falsy — the conditional must treat "" the same as absent.
    // Guards against a regression where "" produces an empty section header.
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 10,
      cycleStatsText: "",
    });
    expect(prompt).not.toContain("track record");
  });

  it("omits memory section when memoryContext is empty string", () => {
    // Guards the "" (falsy) path for memoryContext — must behave like absent.
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 5,
      memoryContext: "",
    });
    expect(prompt).not.toContain("accumulated knowledge");
  });

  it("omits planning section when planningContext is empty string", () => {
    // Guards the "" (falsy) path for planningContext — must behave like absent.
    // loadEvolutionContext may return "" when no planning item is active.
    // Comparing against the absent-field output confirms "" produces no extra content.
    const withEmpty = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 5,
      planningContext: "",
    });
    const withAbsent = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 5,
    });
    expect(withEmpty).toBe(withAbsent);
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

  it("base prompt with empty context is itself under 2000 characters", () => {
    // The static boilerplate in buildAssessmentPrompt should be compact so it
    // doesn't crowd out the journal summary and other dynamic context.
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 1,
    });
    expect(prompt.length).toBeLessThan(2000);
  });

  it("truncates journalSummary that exceeds CONTEXT_JOURNAL_MAX_CHARS", () => {
    // An oversized journal summary must be silently truncated so it cannot
    // inflate the assessment prompt beyond the documented limit.
    const overflowSummary = "J".repeat(CONTEXT_JOURNAL_MAX_CHARS) + "OVERFLOW_SENTINEL";
    const prompt = buildAssessmentPrompt({ journalSummary: overflowSummary, cycleCount: 1 });
    expect(prompt).not.toContain("OVERFLOW_SENTINEL");
  });

  it("does not truncate journalSummary at or below CONTEXT_JOURNAL_MAX_CHARS", () => {
    // Summaries that fit within the limit must be passed through unchanged.
    const exactSummary = "K".repeat(CONTEXT_JOURNAL_MAX_CHARS);
    const prompt = buildAssessmentPrompt({ journalSummary: exactSummary, cycleCount: 1 });
    expect(prompt).toContain(exactSummary);
  });

  it("includes fileManifest section when fileManifest is provided", () => {
    const manifest = "src/evolve.ts\nsrc/assess.ts\ntests/evolve.test.ts";
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 1,
      fileManifest: manifest,
    });
    expect(prompt).toContain("File index");
    expect(prompt).toContain("src/evolve.ts");
    expect(prompt).toContain("tests/evolve.test.ts");
  });

  it("includes no-Glob hint in fileManifest section", () => {
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 1,
      fileManifest: "src/evolve.ts",
    });
    expect(prompt).toContain("no need to Glob");
  });

  it("omits fileManifest section when fileManifest is absent", () => {
    const prompt = buildAssessmentPrompt({ journalSummary: "", cycleCount: 1 });
    expect(prompt).not.toContain("File index");
  });

  it("omits fileManifest section when fileManifest is empty string", () => {
    // Empty string is falsy — must behave the same as absent.
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 1,
      fileManifest: "",
    });
    expect(prompt).not.toContain("File index");
  });

  it("fileManifest section appears after planningContext section in the prompt", () => {
    // Pins the section concatenation order in buildAssessmentPrompt:
    // journal → stats → memory → planningContext → fileManifest.
    // toContain-only tests cannot catch a section reorder — this positional
    // assertion ensures the LLM always sees the file index after the planning
    // context, not before it.
    const prompt = buildAssessmentPrompt({
      journalSummary: "",
      cycleCount: 1,
      planningContext: "PLANNING_SENTINEL: Current item: Improve error handling",
      fileManifest: "src/evolve.ts\ntests/evolve.test.ts",
    });
    const planningIdx = prompt.indexOf("PLANNING_SENTINEL:");
    const fileManifestIdx = prompt.indexOf("File index");
    expect(planningIdx).toBeGreaterThanOrEqual(0);
    expect(fileManifestIdx).toBeGreaterThanOrEqual(0);
    expect(fileManifestIdx).toBeGreaterThan(planningIdx);
  });
});

describe("buildFileManifest", () => {
  it("returns a string", () => {
    // Basic smoke test: the function must not throw and must return a string
    const result = buildFileManifest();
    expect(typeof result).toBe("string");
  });

  it("includes src/ and tests/ .ts files when run from the project root", () => {
    const result = buildFileManifest();
    // The project has evolve.ts in src/ and evolve.test.ts in tests/ —
    // these sentinel files must always appear in the manifest.
    expect(result).toContain("src/evolve.ts");
    expect(result).toContain("tests/evolve.test.ts");
  });

  it("includes scripts/ .ts files when run from the project root", () => {
    const result = buildFileManifest();
    // scripts/ contains generate-pages.ts and other build-time scripts.
    // The agent needs to see these files to understand the full codebase.
    expect(result).toContain("scripts/generate-pages.ts");
  });

  it("includes scripts/export-journal.ts in the file manifest", () => {
    // Sentinel: if this file is renamed or deleted, CI fails immediately rather
    // than silently dropping it from the agent's codebase view.
    const result = buildFileManifest();
    expect(result).toContain("scripts/export-journal.ts");
  });

  it("includes scripts/export-roadmap.ts in the file manifest", () => {
    // Sentinel: if this file is renamed or deleted, CI fails immediately rather
    // than silently dropping it from the agent's codebase view.
    const result = buildFileManifest();
    expect(result).toContain("scripts/export-roadmap.ts");
  });

  it("only contains .ts files (no .js, .json, or other extensions)", () => {
    const result = buildFileManifest();
    if (result.length === 0) return; // empty is acceptable (e.g., missing dirs)
    for (const line of result.split("\n")) {
      expect(line).toMatch(/\.ts$/);
    }
  });

  it("returns empty string when cwd has no src/ or tests/ directories", async () => {
    // Use os.tmpdir() which has no src/ or tests/ subdirectories
    const { tmpdir } = await import("node:os");
    const result = buildFileManifest(tmpdir());
    expect(result).toBe("");
  });

  it("returns files sorted alphabetically", () => {
    // buildFileManifest calls files.sort() before joining — verify the output
    // is in sorted order so callers and the LLM receive a stable, predictable list.
    const result = buildFileManifest();
    if (result.length === 0) return; // skip when dirs are absent (e.g. tmpdir)
    const lines = result.split("\n");
    const sorted = [...lines].sort();
    expect(lines).toEqual(sorted);
  });

  it("returns only tests/ files when src/ directory is missing (partial fallback)", async () => {
    // Guards the per-directory try/catch: if the catch block is ever removed,
    // a missing src/ would throw and the agent would lose all file context.
    const { tmpdir } = await import("node:os");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");

    const tempDir = mkdtempSync(join(tmpdir(), "bloom-manifest-test-"));
    try {
      const testsDir = join(tempDir, "tests");
      mkdirSync(testsDir);
      writeFileSync(join(testsDir, "example.test.ts"), "// test");

      const result = buildFileManifest(tempDir);
      // src/ is absent — only tests/ files should appear, no throw
      expect(result).toBe("tests/example.test.ts");
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  });

  it("returns only src/ files when tests/ directory is missing (partial fallback)", async () => {
    // Symmetric guard for the tests/ directory: a missing tests/ dir must not
    // halt the function — src/ files should still be returned.
    const { tmpdir } = await import("node:os");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");

    const tempDir = mkdtempSync(join(tmpdir(), "bloom-manifest-test-"));
    try {
      const srcDir = join(tempDir, "src");
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, "main.ts"), "// source");

      const result = buildFileManifest(tempDir);
      // tests/ is absent — only src/ files should appear, no throw
      expect(result).toBe("src/main.ts");
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  });

  it("includes files in nested subdirectories with correct path prefix (recursive: true guard)", async () => {
    // readdirSync uses { recursive: true } to collect nested files.
    // A regression removing that flag would silently exclude subdirectory files
    // (e.g. src/subdir/nested.ts), breaking the LLM's file-awareness context.
    // This test creates a real temp dir with a nested source file and asserts
    // the manifest contains the full relative path with the src/ prefix.
    const { tmpdir } = await import("node:os");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");

    const tempDir = mkdtempSync(join(tmpdir(), "bloom-manifest-recurse-"));
    try {
      const subDir = join(tempDir, "src", "subdir");
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, "nested.ts"), "// nested");

      const result = buildFileManifest(tempDir);
      // The nested file must appear with its full relative path
      expect(result).toContain("src/subdir/nested.ts");
    } finally {
      rmSync(tempDir, { recursive: true });
    }
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

  it("enforces rule 1: agent must make only ONE change at a time", () => {
    const prompt = buildEvolutionPrompt("assessment");
    expect(prompt).toContain("Make ONE change at a time");
  });

  it("instructs agent to manually delete new untracked files when reverting", () => {
    // When the LLM creates new files and the build fails, `git checkout .` only
    // reverts tracked files — new untracked files remain. The prompt must
    // explicitly remind the agent to also delete those files so failed attempts
    // don't leave orphaned files that break subsequent improvement attempts.
    const prompt = buildEvolutionPrompt("assessment");
    expect(prompt).toContain("new untracked files");
  });

  it("enforces rule 5: agent must keep changes small and incremental", () => {
    const prompt = buildEvolutionPrompt("assessment");
    expect(prompt).toContain("Keep changes small and incremental");
  });

  it("instructs agent to provide structured summary", () => {
    const prompt = buildEvolutionPrompt("assessment");
    expect(prompt).toContain("ATTEMPTED:");
    expect(prompt).toContain("SUCCEEDED:");
    expect(prompt).toContain("FAILED:");
    expect(prompt).toContain("LEARNINGS:");
    expect(prompt).toContain("STRATEGIC_CONTEXT:");
  });

  it("STRATEGIC_CONTEXT marker includes angle-bracket placeholder describing expected content", () => {
    const prompt = buildEvolutionPrompt("assessment");
    const idx = prompt.indexOf("STRATEGIC_CONTEXT:");
    expect(idx).toBeGreaterThan(-1);
    // Marker must be followed by the angle-bracket hint so agents know what to write
    const after = prompt.slice(idx);
    expect(after).toMatch(/STRATEGIC_CONTEXT:\s*<[^>]+>/);
  });

  it("LEARNINGS section shows bullet-list format so extractLearnings can parse it", () => {
    const prompt = buildEvolutionPrompt("assessment");
    // extractLearnings requires lines starting with -, *, or digit.
    // The prompt must model this so the agent produces parseable output.
    const learningsIdx = prompt.indexOf("LEARNINGS:");
    expect(learningsIdx).toBeGreaterThan(-1);
    const afterLearnings = prompt.slice(learningsIdx);
    expect(afterLearnings).toMatch(/LEARNINGS:\s*\n-\s+/);
    // The example lines must include the [category] placeholder so the agent
    // knows to tag its learnings — without it memory categorisation silently degrades.
    expect(afterLearnings).toContain("[category]");
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

  it("omits usage section when usageContext is empty string", () => {
    // Empty string is falsy — must behave identically to absent usageContext.
    // Guards against a regression where "" != undefined produces an empty section header.
    const withEmpty = buildEvolutionPrompt("assessment text", { usageContext: "" });
    const withAbsent = buildEvolutionPrompt("assessment text");
    expect(withEmpty).toBe(withAbsent);
    expect(withEmpty).not.toContain("Resource usage");
  });

  it("omits outcome section when outcomeContext is empty string", () => {
    // Mirrors the usageContext guard: "" must behave like absent outcomeContext.
    const withEmpty = buildEvolutionPrompt("assessment text", { outcomeContext: "" });
    const withAbsent = buildEvolutionPrompt("assessment text");
    expect(withEmpty).toBe(withAbsent);
    expect(withEmpty).not.toContain("Cycle outcome metrics");
  });

  it("omits both usage and outcome sections when neither context is provided", () => {
    // Structural pin for the combined-absent path: both optional context sections
    // must be absent when neither usageContext nor outcomeContext is supplied.
    // Prevents silent drift if the template introduces extra blank lines or section
    // headers when both are omitted (complements the individual-omission tests above).
    const promptNone = buildEvolutionPrompt("assessment text");
    const promptBothEmpty = buildEvolutionPrompt("assessment text", { usageContext: "", outcomeContext: "" });
    expect(promptNone).not.toContain("Resource usage");
    expect(promptNone).not.toContain("Cycle outcome metrics");
    // All three forms (no options, empty object, both empty strings) must be identical
    expect(promptBothEmpty).toBe(promptNone);
  });

  it("truncates assessment text that exceeds ASSESSMENT_CHAR_LIMIT", () => {
    // An assessment longer than ASSESSMENT_CHAR_LIMIT should be silently truncated
    // so oversized LLM output cannot inflate the evolution prompt.
    const overflowText = "A".repeat(ASSESSMENT_CHAR_LIMIT) + "OVERFLOW_SENTINEL";
    const prompt = buildEvolutionPrompt(overflowText);
    expect(prompt).not.toContain("OVERFLOW_SENTINEL");
  });

  it("does not truncate assessment text at or below ASSESSMENT_CHAR_LIMIT", () => {
    // Assessments that fit within the limit must be passed through unchanged.
    const exactText = "B".repeat(ASSESSMENT_CHAR_LIMIT);
    const prompt = buildEvolutionPrompt(exactText);
    expect(prompt).toContain(exactText);
  });

  it("truncated assessment (no newlines) embeds exactly ASSESSMENT_CHAR_LIMIT characters — no more, no less", () => {
    // When the overflow text has no newlines, the hard limit is used as-is.
    // Verify: all ASSESSMENT_CHAR_LIMIT chars are kept and the +1 char is dropped.
    const overflowText = "A".repeat(ASSESSMENT_CHAR_LIMIT + 1);
    const prompt = buildEvolutionPrompt(overflowText);
    // All first ASSESSMENT_CHAR_LIMIT characters must be present (no under-truncation)
    expect(prompt).toContain("A".repeat(ASSESSMENT_CHAR_LIMIT));
    // The full over-limit string must not appear (confirms the +1 char was removed)
    expect(prompt).not.toContain(overflowText);
  });

  it("truncation snaps to last newline so items are not severed mid-sentence", () => {
    // Build a text where a newline falls just before the limit, followed by more
    // content that pushes the total over ASSESSMENT_CHAR_LIMIT. The truncation
    // should snap to the newline, preserving whole items.
    const beforeNewline = "X".repeat(ASSESSMENT_CHAR_LIMIT - 10) + "\n";
    const afterNewline = "Y".repeat(20); // pushes total over limit
    const overflowText = beforeNewline + afterNewline;
    const prompt = buildEvolutionPrompt(overflowText);
    // Content after the newline must be excluded
    expect(prompt).not.toContain("Y".repeat(20));
    // Content up to the newline must be preserved
    expect(prompt).toContain("X".repeat(ASSESSMENT_CHAR_LIMIT - 10));
  });

  it("section order: assessment → usageSection → outcomeSection → RULES (positional guard)", () => {
    // toContain-only tests cannot catch a template reorder — this positional test
    // pins the relative order of the four key sections in buildEvolutionPrompt.
    // A reorder (e.g. outcomeSection before usageSection, or RULES before outcome)
    // would be caught immediately by these indexOf comparisons.
    const ASSESSMENT_SENTINEL = "ASSESSMENT_SENTINEL_XYZ";
    const prompt = buildEvolutionPrompt(ASSESSMENT_SENTINEL, {
      usageContext: "USAGE_SENTINEL_XYZ",
      outcomeContext: "OUTCOME_SENTINEL_XYZ",
    });
    const assessmentIdx = prompt.indexOf("ASSESSMENT_SENTINEL_XYZ");
    const usageIdx = prompt.indexOf("USAGE_SENTINEL_XYZ");
    const outcomeIdx = prompt.indexOf("OUTCOME_SENTINEL_XYZ");
    const rulesIdx = prompt.indexOf("RULES:");
    // All four sections must be present
    expect(assessmentIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(outcomeIdx).toBeGreaterThanOrEqual(0);
    expect(rulesIdx).toBeGreaterThanOrEqual(0);
    // Order: assessment < usage < outcome < RULES
    expect(assessmentIdx).toBeLessThan(usageIdx);
    expect(usageIdx).toBeLessThan(outcomeIdx);
    expect(outcomeIdx).toBeLessThan(rulesIdx);
  });

  it("emits a console.warn when assessment exceeds ASSESSMENT_CHAR_LIMIT", () => {
    // A truncation-warn must fire whenever the assessment is over-limit so CI logs
    // surface the event — previously truncation was completely invisible.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const overflowText = "D".repeat(ASSESSMENT_CHAR_LIMIT + 1);
    buildEvolutionPrompt(overflowText);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("truncated");
    warnSpy.mockRestore();
  });

  it("does NOT emit a console.warn when assessment is at or below ASSESSMENT_CHAR_LIMIT", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    buildEvolutionPrompt("E".repeat(ASSESSMENT_CHAR_LIMIT));
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("truncated assessment still produces a structurally complete prompt", () => {
    // Even when the assessment is sliced mid-content, the surrounding prompt
    // structure must remain intact so the evolution agent receives valid rules
    // and the required output format markers.
    const overflowText = "C".repeat(ASSESSMENT_CHAR_LIMIT + 500);
    const prompt = buildEvolutionPrompt(overflowText);
    // Core rules section must always be present
    expect(prompt).toContain("RULES:");
    // All five required output-format markers must appear after the assessment
    expect(prompt).toContain("ATTEMPTED:");
    expect(prompt).toContain("SUCCEEDED:");
    expect(prompt).toContain("FAILED:");
    expect(prompt).toContain("LEARNINGS:");
    expect(prompt).toContain("STRATEGIC_CONTEXT:");
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

  it("parses single-hash header format like # ATTEMPTED (HEADER_RE minimum)", () => {
    const input = `# ATTEMPTED
- Single-hash attempt
# SUCCEEDED
Single-hash success`;
    const result = parseEvolutionResult(input);
    expect(result.attempted).toContain("- Single-hash attempt");
    expect(result.succeeded).toContain("Single-hash success");
  });

  it("parses quad-hash header format like #### ATTEMPTED (HEADER_RE maximum)", () => {
    const input = `#### ATTEMPTED
- Quad-hash attempt
#### SUCCEEDED
Quad-hash success`;
    const result = parseEvolutionResult(input);
    expect(result.attempted).toContain("- Quad-hash attempt");
    expect(result.succeeded).toContain("Quad-hash success");
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

  it("concatenates both blocks when the same section header appears twice", () => {
    // When SUCCEEDED appears twice, both blocks are accumulated into the same
    // key (concatenation semantics). This test documents and locks in that
    // behaviour so a future last-wins refactor is caught immediately.
    const input = `ATTEMPTED: First attempt
SUCCEEDED: First success block
FAILED: none
SUCCEEDED: Second success block`;
    const result = parseEvolutionResult(input);
    expect(result.succeeded).toContain("First success block");
    expect(result.succeeded).toContain("Second success block");
  });

  it("ignores unrecognised section headers mid-parse and keeps accumulating into the last known section", () => {
    // An unrecognised header (e.g. NOTES:) does not match HEADER_RE's known
    // keyword set, so no section switch occurs — subsequent lines continue
    // to accumulate into the previously active section.
    const input = `ATTEMPTED: Real content
NOTES: This is not a known header
Still part of attempted`;
    const result = parseEvolutionResult(input);
    // "NOTES:" line and the line after it should both land in attempted
    expect(result.attempted).toContain("Real content");
    expect(result.attempted).toContain("NOTES: This is not a known header");
    expect(result.attempted).toContain("Still part of attempted");
  });

  it("bare keyword without colon does NOT switch sections (regression: false-positive HEADER_RE)", () => {
    // A content line like "FAILED to compile X" inside a LEARNINGS block used to
    // incorrectly flip the active section because the old HEADER_RE made the colon
    // optional for bare keywords.  The fix requires a colon for the bare-keyword path.
    const input = `LEARNINGS: Key insight here
FAILED to compile something important
More learning content`;
    const result = parseEvolutionResult(input);
    // The "FAILED to compile…" line must stay in learnings, not switch to failed
    expect(result.learnings).toContain("Key insight here");
    expect(result.learnings).toContain("FAILED to compile something important");
    expect(result.learnings).toContain("More learning content");
    expect(result.failed).toBe("");
  });

  it("normalises CRLF line endings so section bodies contain no bare \\r", () => {
    // If an LLM returns CRLF-terminated output, raw `line` values embedded in
    // section bodies would carry a trailing \r on every interior line.  The
    // result.replace(/\r\n/g,"\n") guard at the top of parseEvolutionResult
    // must strip them before the split, keeping sections \r-free throughout.
    const input =
      "ATTEMPTED: Fix regex bug\r\n- Detail 1\r\n- Detail 2\r\nSUCCEEDED: Regex fixed\r\nFAILED: none\r\nLEARNINGS: [pattern] Always test\r\nSTRATEGIC_CONTEXT: Focused on parsing.\r\n";
    const result = parseEvolutionResult(input);
    expect(result.attempted).not.toContain("\r");
    expect(result.succeeded).not.toContain("\r");
    expect(result.failed).not.toContain("\r");
    expect(result.learnings).not.toContain("\r");
    expect(result.strategic_context).not.toContain("\r");
    // Verify content is actually parsed correctly
    expect(result.attempted).toContain("Fix regex bug");
    expect(result.attempted).toContain("- Detail 1");
    expect(result.succeeded).toContain("Regex fixed");
  });
});

describe("cross-phase integration: buildAssessmentPrompt → buildEvolutionPrompt", () => {
  it("embeds a 2000-char assessment without truncation", () => {
    // A max-size assessment (exactly ASSESSMENT_CHAR_LIMIT chars) must survive
    // the round-trip without any characters being dropped.
    const fullAssessment = "A".repeat(ASSESSMENT_CHAR_LIMIT);
    const evolutionPrompt = buildEvolutionPrompt(fullAssessment);
    expect(evolutionPrompt).toContain("A".repeat(ASSESSMENT_CHAR_LIMIT));
  });

  it("RULES section survives the round-trip", () => {
    // The assessment output is used verbatim as the evolution prompt preamble;
    // the RULES section must always appear after it, intact.
    const assessment = buildAssessmentPrompt({
      journalSummary: "## Cycle 5",
      cycleCount: 5,
    });
    const evolutionPrompt = buildEvolutionPrompt(assessment);
    expect(evolutionPrompt).toContain("RULES:");
    expect(evolutionPrompt).toContain("pnpm build && pnpm test");
    expect(evolutionPrompt).toContain("NEVER modify IDENTITY.md");
    expect(evolutionPrompt).toContain("Do NOT write to JOURNAL.md");
  });

  it("all five section markers are present after the assessment is embedded", () => {
    // Guard the critical cross-phase contract: a full assessment output (with
    // cycle stats and memory context) embedded into the evolution prompt must
    // still expose all five required structured-summary markers.
    const assessment = buildAssessmentPrompt({
      journalSummary: "## Cycle 7\nRecent journal entry.",
      cycleCount: 7,
      cycleStatsText: "Total: 6 | Success: 83%",
      memoryContext: "[process] Always run tests before committing",
    });
    // Simulate an LLM response that is within the char limit
    const truncated = assessment.slice(0, ASSESSMENT_CHAR_LIMIT);
    const evolutionPrompt = buildEvolutionPrompt(truncated);
    expect(evolutionPrompt).toContain("ATTEMPTED:");
    expect(evolutionPrompt).toContain("SUCCEEDED:");
    expect(evolutionPrompt).toContain("FAILED:");
    expect(evolutionPrompt).toContain("LEARNINGS:");
    expect(evolutionPrompt).toContain("STRATEGIC_CONTEXT:");
  });

  it("oversized assessment is truncated but markers still present", () => {
    // Simulates the LLM returning more than ASSESSMENT_CHAR_LIMIT chars.
    // buildEvolutionPrompt must truncate it and still produce a valid prompt.
    const oversized = "B".repeat(ASSESSMENT_CHAR_LIMIT + 500);
    const evolutionPrompt = buildEvolutionPrompt(oversized);
    expect(evolutionPrompt).not.toContain("B".repeat(ASSESSMENT_CHAR_LIMIT + 1));
    expect(evolutionPrompt).toContain("RULES:");
    expect(evolutionPrompt).toContain("ATTEMPTED:");
    expect(evolutionPrompt).toContain("STRATEGIC_CONTEXT:");
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

  it("returns 0 for null input without throwing (runtime safety guard)", () => {
    // At runtime a DB row or LLM response field can be null despite the string type annotation.
    // The `if (!text) return 0` guard must prevent a TypeError from .split().
    expect(countImprovements(null as unknown as string)).toBe(0);
  });

  it("returns 0 for undefined input without throwing (runtime safety guard)", () => {
    expect(countImprovements(undefined as unknown as string)).toBe(0);
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

  it("multi-line branch fires at minimum threshold of exactly 2 non-empty lines", () => {
    // "1) foo. 2) bar.\nsome prose" has:
    //   lineCount = 1  (only line 1 starts with "N) ")
    //   nonEmptyLines = 2  (both lines are non-empty → threshold met)
    //   inlineCount = 2  (two "N) " matches across the whole text)
    // Since lineCount > 0 && nonEmptyLines > 1 is true, the multi-line branch
    // fires and returns lineCount (1), not Math.max(1, 2) = 2.
    expect(countImprovements("1) foo. 2) bar.\nsome prose")).toBe(1);
  });

  it("counts CRLF-terminated bullet list correctly (LLM output regression)", () => {
    // LLM responses sometimes use CRLF line endings; without explicit
    // normalization, .split("\n") would leave trailing \r on each token,
    // causing LINE_LIST_RE to fail and returning 0 instead of 2.
    expect(countImprovements("- A\r\n- B")).toBe(2);
  });
});

