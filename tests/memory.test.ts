import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { initDb, insertCycle, insertLearning, getRelevantLearnings, decayLearningRelevance, pruneLowRelevanceLearnings, insertStrategicContext, getLatestStrategicContext } from "../src/db.js";
import { extractLearnings, storeLearnings, storeStrategicContext, formatMemoryForPrompt, MAX_MEMORY_CHARS, STRATEGIC_CONTEXT_RETENTION_CYCLES, MAX_RELEVANT_LEARNINGS_TO_FETCH, MEMORY_STRATEGIC_CONTEXT_HEADER, MEMORY_KEY_LEARNINGS_HEADER, LEARNING_CATEGORIES, type ExtractedLearnings } from "../src/memory.js";
import { makeOutcome } from "./helpers.js";

describe("extractLearnings", () => {
  it("returns empty for blank input", () => {
    expect(extractLearnings("")).toEqual({ learnings: [] });
    expect(extractLearnings("   ")).toEqual({ learnings: [] });
  });

  it("returns empty for null input without throwing (runtime safety guard)", () => {
    // At runtime a DB row with a NULL learnings column can bypass the string
    // type annotation. The guard must prevent a TypeError from .trim().
    expect(extractLearnings(null as unknown as string)).toEqual({ learnings: [] });
  });

  it("returns empty for undefined input without throwing (runtime safety guard)", () => {
    expect(extractLearnings(undefined as unknown as string)).toEqual({ learnings: [] });
  });

  it("parses categorized learnings with [category] prefix", () => {
    const text = `- [pattern] Writing tests before implementation catches edge cases
- [anti-pattern] Avoid modifying multiple files in one commit
- [tool-usage] pnpm build is faster with incremental compilation`;
    const result = extractLearnings(text);
    expect(result.learnings).toHaveLength(3);
    expect(result.learnings[0].category).toBe("pattern");
    expect(result.learnings[0].content).toBe("Writing tests before implementation catches edge cases");
    expect(result.learnings[1].category).toBe("anti-pattern");
    expect(result.learnings[2].category).toBe("tool-usage");
  });

  it("defaults to domain for untagged learnings", () => {
    const text = "- Always validate input parameters";
    const result = extractLearnings(text);
    expect(result.learnings).toHaveLength(1);
    expect(result.learnings[0].category).toBe("domain");
    expect(result.learnings[0].content).toBe("Always validate input parameters");
  });

  it("handles numbered list items", () => {
    const text = "1. [pattern] First insight\n2. Second insight";
    const result = extractLearnings(text);
    expect(result.learnings).toHaveLength(2);
    expect(result.learnings[0].category).toBe("pattern");
    expect(result.learnings[1].category).toBe("domain");
  });

  it("recognises explicit [domain] tag and strips it", () => {
    // Uses the categoryMatch branch (not the untagged fallback path).
    // "domain" is in LEARNING_CATEGORIES so category must be "domain" and the
    // bracket tag must be stripped from cleanContent.
    const text = "- [domain] Explicit domain insight";
    const result = extractLearnings(text);
    expect(result.learnings).toHaveLength(1);
    expect(result.learnings[0].category).toBe("domain");
    expect(result.learnings[0].content).toBe("Explicit domain insight");
  });

  it("handles asterisk list items", () => {
    const text = "* [domain] Asterisk insight";
    const result = extractLearnings(text);
    expect(result.learnings).toHaveLength(1);
    expect(result.learnings[0].content).toBe("Asterisk insight");
  });

  it("ignores non-list lines", () => {
    const text = "Some preamble text\n- [pattern] Actual learning\nMore text";
    const result = extractLearnings(text);
    expect(result.learnings).toHaveLength(1);
  });

  it("ignores unknown category prefixes and emits a console.warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const text = "- [unknown] Some insight";
    const result = extractLearnings(text);
    expect(result.learnings).toHaveLength(1);
    expect(result.learnings[0].category).toBe("domain");
    expect(result.learnings[0].content).toBe("Some insight");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[memory] extractLearnings: unrecognized category "[unknown]"'),
    );
    warnSpy.mockRestore();
  });

  it("recognises [process] as a valid category without falling back to domain", () => {
    const text = "- [process] Verifying a metrics fix requires re-running the full test suite";
    const result = extractLearnings(text);
    expect(result.learnings).toHaveLength(1);
    expect(result.learnings[0].category).toBe("process");
    expect(result.learnings[0].content).toBe(
      "Verifying a metrics fix requires re-running the full test suite",
    );
  });

  it("silently drops bare [category] lines that lack a leading bullet", () => {
    // Lines starting with '[' do not match the ^[-*\d] guard in extractLearnings,
    // so they are skipped. This test documents that constraint so future readers
    // don't try to 'fix' extractLearnings without first updating the prompt format.
    const result = extractLearnings("[pattern] Bare line without bullet");
    expect(result).toEqual({ learnings: [] });
  });

  it("silently drops bullet lines whose [category] tag has no trailing content", () => {
    // A line like '- [pattern]' passes the bullet guard and the category match,
    // but cleanContent.trim() is empty so the guard at line 67 discards it.
    // This test documents that existing correct behaviour so the guard is not
    // accidentally removed in future refactors.
    const result = extractLearnings("- [pattern]");
    expect(result).toEqual({ learnings: [] });
  });

  it("silently drops bullet lines with a recognized category tag but whitespace-only content", () => {
    // '- [pattern]   ' has categoryMatch[2] === '   ' (all spaces); after
    // cleanContent.trim() the content is empty and the entry is discarded.
    // This boundary pins the whitespace-trim guard for recognised categories,
    // complementing the bare-tag test above.
    const result = extractLearnings("- [pattern]   ");
    expect(result).toEqual({ learnings: [] });
  });

  it("produces zero learnings for a mix of empty-tag and blank lines", () => {
    const text = "- [pattern]\n- [anti-pattern]\n\n- [tool-usage]";
    const result = extractLearnings(text);
    expect(result.learnings).toHaveLength(0);
  });

  it("drops bullet lines with bare [unknown-category] and no trailing content (and warns)", () => {
    // `- [unknown]` passes the bullet guard and the categoryMatch regex, but
    // categoryMatch[2] is "" (not undefined — `.*` in the regex always captures
    // at least an empty string). cleanContent.trim() === "" so the empty-content
    // guard discards the entry; a warning is emitted for the unrecognized tag.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = extractLearnings("- [unknown]");
    expect(result).toEqual({ learnings: [] });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[memory] extractLearnings: unrecognized category "[unknown]"'),
    );
    warnSpy.mockRestore();
  });

  it("produces zero learnings for a mix of bare unknown and known empty tags", () => {
    // `.*` in the category regex always captures at least an empty string, so
    // cleanContent is "" for all entries; they are dropped by the empty-content
    // guard. Warnings fire for the two unrecognized tags ([unknown], [mystery])
    // but not for [pattern] which is a valid category.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const text = "- [unknown]\n- [mystery]\n- [pattern]";
    const result = extractLearnings(text);
    expect(result.learnings).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("strips N) bullet prefix and extracts category correctly", () => {
    const text = "1) [pattern] Use incremental commits for safer rollback";
    const result = extractLearnings(text);
    expect(result.learnings).toHaveLength(1);
    expect(result.learnings[0].category).toBe("pattern");
    expect(result.learnings[0].content).toBe("Use incremental commits for safer rollback");
  });

  it("strips N) bullet prefix and defaults to domain when no category tag", () => {
    const text = "2) Always run tests before committing";
    const result = extractLearnings(text);
    expect(result.learnings).toHaveLength(1);
    expect(result.learnings[0].category).toBe("domain");
    expect(result.learnings[0].content).toBe("Always run tests before committing");
  });
});

describe("storeLearnings", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
  });

  it("inserts learnings into the database", () => {
    const extracted = extractLearnings("- [pattern] Test first\n- [domain] Know your tools");
    storeLearnings(db, 1, extracted);
    const learnings = getRelevantLearnings(db, 10);
    expect(learnings).toHaveLength(2);
    const categories = learnings.map(l => l.category).sort();
    expect(categories).toEqual(["domain", "pattern"]);
  });

  it("does nothing for empty learnings", () => {
    storeLearnings(db, 1, { learnings: [] });
    expect(getRelevantLearnings(db, 10)).toHaveLength(0);
  });

  it("returns the count of new learnings stored", () => {
    const extracted = extractLearnings("- [pattern] First insight\n- [domain] Second insight");
    expect(storeLearnings(db, 1, extracted).count).toBe(2);
  });

  it("returns 0 when all learnings are duplicates", () => {
    const extracted = extractLearnings("- [pattern] Unique insight about testing");
    storeLearnings(db, 1, extracted);
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    expect(storeLearnings(db, 2, extracted).count).toBe(0);
  });

  it("returns 0 for empty learnings", () => {
    expect(storeLearnings(db, 1, { learnings: [] }).count).toBe(0);
  });

  it("does not insert duplicate learnings when called twice with the same content", () => {
    const extracted = extractLearnings("- [pattern] Unique insight about testing");
    storeLearnings(db, 1, extracted);
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    storeLearnings(db, 2, extracted);
    const learnings = getRelevantLearnings(db, 10);
    expect(learnings).toHaveLength(1);
    expect(learnings[0].content).toBe("Unique insight about testing");
  });

  it("cross-cycle dedup: count is 0 and DB has exactly 1 row when same content re-submitted next cycle", () => {
    // Explicit combined assertion: exercises the LOWER(TRIM(?)) real SQLite path
    // to confirm the unique-content guard prevents runaway table growth across cycles.
    const extracted = extractLearnings("- [domain] Dedup guard real SQLite check");
    storeLearnings(db, 1, extracted);

    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    const result = storeLearnings(db, 2, extracted);

    expect(result.count).toBe(0);
    expect(getRelevantLearnings(db, 10)).toHaveLength(1);
  });

  it("cross-cycle dedup: case/whitespace variants are rejected via LOWER(TRIM) guard", () => {
    // First cycle: store the canonical form
    storeLearnings(db, 1, { learnings: [{ category: "pattern", content: "Use transactions for batch writes" }] });

    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    // Second cycle: submit with different casing — LOWER(TRIM) should block it
    const result = storeLearnings(db, 2, { learnings: [{ category: "pattern", content: "use transactions for batch writes" }] });

    expect(result.count).toBe(0);
    expect(getRelevantLearnings(db, 10)).toHaveLength(1);
  });

  it("deduplicates learnings within the same batch (same content, same call)", () => {
    // Two identical items in one batch — only the first should be inserted.
    const extracted: ExtractedLearnings = {
      learnings: [
        { category: "pattern", content: "Repeated insight" },
        { category: "domain",  content: "Repeated insight" },
      ],
    };
    const { count } = storeLearnings(db, 1, extracted);
    expect(count).toBe(1);
    const learnings = getRelevantLearnings(db, 10);
    expect(learnings).toHaveLength(1);
    expect(learnings[0].content).toBe("Repeated insight");
  });

  it("deduplicates case-insensitively within the same batch", () => {
    const extracted: ExtractedLearnings = {
      learnings: [
        { category: "pattern", content: "Case Insight" },
        { category: "pattern", content: "case insight" },
      ],
    };
    const { count } = storeLearnings(db, 1, extracted);
    expect(count).toBe(1);
    expect(getRelevantLearnings(db, 10)).toHaveLength(1);
  });

  it("does not decay existing learnings when new learnings list is empty", () => {
    // Insert an existing learning with default relevance 1.0
    insertLearning(db, 1, "domain", "Existing learning");
    const before = getRelevantLearnings(db, 10);
    expect(before[0].relevance).toBe(1.0);

    // Call storeLearnings with an empty list — decay must NOT be applied
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    storeLearnings(db, 2, { learnings: [] });

    const after = getRelevantLearnings(db, 10);
    expect(after).toHaveLength(1);
    expect(after[0].relevance).toBe(1.0);
  });

  it("applies decay to existing learnings before inserting new ones", () => {
    insertLearning(db, 1, "domain", "Old learning");

    // Verify initial relevance
    const before = getRelevantLearnings(db, 10);
    expect(before[0].relevance).toBe(1.0);

    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    storeLearnings(db, 2, extractLearnings("- New learning"));

    const after = getRelevantLearnings(db, 10);
    // New learning should have relevance 1.0, old should be decayed
    const oldLearning = after.find(l => l.content === "Old learning");
    const newLearning = after.find(l => l.content === "New learning");
    expect(newLearning!.relevance).toBe(1.0);
    expect(oldLearning!.relevance).toBeLessThan(1.0);
    expect(oldLearning!.relevance).toBeCloseTo(0.95);
  });

  it("survives a DB IO error during dedup lookup without throwing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Intercept db.prepare so the SELECT 1 lookup throws to simulate IO failure
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("SELECT 1 FROM learnings")) {
        return { get: () => { throw new Error("disk full"); } } as unknown as ReturnType<typeof db.prepare>;
      }
      return originalPrepare(sql);
    });

    const extracted: ExtractedLearnings = {
      learnings: [{ category: "domain", content: "IO error learning" }],
    };

    // Must not throw — the try-catch keeps the cycle alive
    expect(() => storeLearnings(db, 1, extracted)).not.toThrow();
    // Dedup is skipped but the learning IS inserted to keep the cycle alive.
    // dedupSkipped must be 1 so the orchestrator can log/track the blind spot.
    const result = storeLearnings(db, 1, extracted);
    expect(result.count).toBe(1);
    expect(result.dedupSkipped).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[memory] storeLearnings: DB lookup failed"),
      expect.any(Error),
    );

    vi.restoreAllMocks();
    warnSpy.mockRestore();
  });
});

describe("formatMemoryForPrompt", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
  });

  it("returns empty string when no memory exists", () => {
    expect(formatMemoryForPrompt(db)).toBe("");
  });

  it("includes strategic context first", () => {
    insertStrategicContext(db, 1, "Focusing on reliability.");
    const result = formatMemoryForPrompt(db);
    expect(result).toContain("## Strategic Context");
    expect(result).toContain("Focusing on reliability.");
  });

  it("strategic-context-only path: exact full-output toBe pin", () => {
    insertStrategicContext(db, 1, "Focusing on reliability.");
    const result = formatMemoryForPrompt(db);
    expect(result).toBe("## Strategic Context\nFocusing on reliability.\n");
  });

  it("learnings-only path: exact full-output toBe pin (no strategic context)", () => {
    // Closes the learnings-only slot in the formatMemoryForPrompt matrix.
    // No strategic context is stored — only one 'pattern' learning.
    // Pins separator absence, header casing, and category-header format in one assertion.
    insertLearning(db, 1, "pattern", "a learning");
    const result = formatMemoryForPrompt(db);
    expect(result).toBe("## Key Learnings\n### pattern (1)\n- a learning\n");
  });

  it("includes learnings grouped by category", () => {
    insertLearning(db, 1, "pattern", "Test before implementing");
    insertLearning(db, 1, "anti-pattern", "Avoid big refactors");
    const result = formatMemoryForPrompt(db);
    expect(result).toContain("## Key Learnings");
    expect(result).toContain("Test before implementing");
    expect(result).toContain("Avoid big refactors");
  });

  it("respects maxChars budget", () => {
    insertStrategicContext(db, 1, "A".repeat(100));
    for (let i = 0; i < 50; i++) {
      insertLearning(db, 1, "domain", `Learning number ${i} with some extra text to make it long`);
    }
    const result = formatMemoryForPrompt(db, 300);
    expect(result.length).toBeLessThanOrEqual(300); // invariant: result.length <= maxChars
  });

  it("truncates mid-category when budget exhausted between items", () => {
    // Insert learnings across two categories
    for (let i = 0; i < 5; i++) {
      insertLearning(db, 1, "pattern", `Pattern learning ${i}`);
    }
    for (let i = 0; i < 5; i++) {
      insertLearning(db, 1, "domain", `Domain learning ${i}`);
    }

    // Use a budget that fits the header + some pattern learnings but not all + domain
    const fullResult = formatMemoryForPrompt(db, 100000);
    const tightBudget = Math.floor(fullResult.length * 0.4);
    const truncated = formatMemoryForPrompt(db, tightBudget);

    // Should contain the section header
    expect(truncated).toContain("## Key Learnings");
    // Should contain at least one learning from the first category
    expect(truncated).toMatch(/learning \d/);
    // Should be shorter than the full result (some items truncated)
    expect(truncated.length).toBeLessThan(fullResult.length);
  });

  it("omits empty Key Learnings header when budget prevents any items", () => {
    // Learnings exist but budget is too tight for any items after the header
    insertLearning(db, 1, "pattern", "Should not appear");
    // Budget just barely too small for header + category header + item
    const result = formatMemoryForPrompt(db, 5);
    // Should not contain a bare "## Key Learnings" header with no content
    expect(result).not.toContain("## Key Learnings");
  });

  it("excludes learnings entirely when strategic context fills the budget", () => {
    const longContext = "X".repeat(200);
    insertStrategicContext(db, 1, longContext);
    insertLearning(db, 1, "pattern", "Should not appear");
    // Budget barely fits the strategic context section
    const contextSection = `## Strategic Context\n${longContext}\n`;
    const result = formatMemoryForPrompt(db, contextSection.length + 5);
    expect(result).toContain("Strategic Context");
    expect(result).not.toContain("Should not appear");
  });

  it("includes at least some learnings when budget allows after strategic context", () => {
    insertStrategicContext(db, 1, "Short context.");
    insertLearning(db, 1, "pattern", "First learning");
    insertLearning(db, 1, "pattern", "Second learning");
    // Large budget should include everything
    const result = formatMemoryForPrompt(db, 100000);
    expect(result).toContain("First learning");
    expect(result).toContain("Second learning");
  });

  it("stops adding items within a category when budget is reached", () => {
    // No strategic context — all budget goes to learnings
    for (let i = 0; i < 20; i++) {
      insertLearning(db, 1, "domain", `Learning item number ${i} with padding text`);
    }
    const fullResult = formatMemoryForPrompt(db, 100000);
    // Use a tight budget that fits header + a few items but not all
    const tightBudget = Math.floor(fullResult.length * 0.3);
    const truncated = formatMemoryForPrompt(db, tightBudget);
    expect(truncated).toContain("## Key Learnings");
    expect(truncated.length).toBeLessThan(fullResult.length);
    // Count how many learning lines appear
    const learningLines = truncated.split("\n").filter(l => l.startsWith("- Learning"));
    expect(learningLines.length).toBeGreaterThan(0);
    expect(learningLines.length).toBeLessThan(20);
  });

  it("does not add empty category headers when budget exhausted mid-category", () => {
    // Insert learnings in two categories — budget should exhaust within the first
    for (let i = 0; i < 5; i++) {
      insertLearning(db, 1, "pattern", `Pattern item ${i} with padding text to consume budget`);
    }
    for (let i = 0; i < 5; i++) {
      insertLearning(db, 1, "anti-pattern", `Anti-pattern item ${i} with padding text`);
    }
    const fullResult = formatMemoryForPrompt(db, 100000);
    // Budget that fits header + some pattern items but exhausts mid-category
    const tightBudget = Math.floor(fullResult.length * 0.35);
    const truncated = formatMemoryForPrompt(db, tightBudget);

    // Every "### category" header must have at least one "- " item line following it
    const lines = truncated.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("### ")) {
        // Next non-empty line must be a learning item
        const nextContentLine = lines.slice(i + 1).find(l => l.trim() !== "");
        expect(nextContentLine).toBeDefined();
        expect(nextContentLine!.startsWith("- ")).toBe(true);
      }
    }
  });

  it("does not add empty category header when header fits but first item does not", () => {
    // One short item in the first category, one long item in the second
    insertLearning(db, 1, "pattern", "Short");
    insertLearning(db, 1, "anti-pattern", "This is a long anti-pattern item that will not fit");

    const fullResult = formatMemoryForPrompt(db, 100000);
    // Build a budget that fits: section header + ### pattern + "- Short\n" + ### anti-pattern
    // but NOT the long anti-pattern item
    const upToSecondHeader =
      "## Key Learnings\n".length +
      "### pattern (1)\n".length +
      "- Short\n".length +
      "### anti-pattern (1)\n".length;
    // Budget allows the anti-pattern header but not its first item
    const result = formatMemoryForPrompt(db, upToSecondHeader + 2);

    // The anti-pattern category header must NOT appear without any item following it
    const lines = result.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("### ")) {
        const nextContentLine = lines.slice(i + 1).find(l => l.trim() !== "");
        expect(nextContentLine).toBeDefined();
        expect(nextContentLine!.startsWith("- ")).toBe(true);
      }
    }
    // The full result should be longer (anti-pattern item was cut)
    expect(result.length).toBeLessThan(fullResult.length);
  });

  it("stops adding category headers when budget is exhausted", () => {
    // Insert learnings in two categories
    for (let i = 0; i < 10; i++) {
      insertLearning(db, 1, "pattern", `Pattern item ${i} with some extra text`);
    }
    for (let i = 0; i < 10; i++) {
      insertLearning(db, 1, "anti-pattern", `Anti-pattern item ${i} with some extra text`);
    }
    const fullResult = formatMemoryForPrompt(db, 100000);
    // Budget fits first category but not second
    const tightBudget = Math.floor(fullResult.length * 0.5);
    const truncated = formatMemoryForPrompt(db, tightBudget);
    expect(truncated.length).toBeLessThan(fullResult.length);
  });

  it("includes both strategic context and learnings", () => {
    insertStrategicContext(db, 1, "Building test infrastructure.");
    insertLearning(db, 1, "pattern", "Small incremental changes work best");
    const result = formatMemoryForPrompt(db);
    expect(result).toContain("Strategic Context");
    expect(result).toContain("Key Learnings");
  });

  it("both-sections path: exact full-output toBe pin (strategic + one learning)", () => {
    // Locks down separator position, header order, and category-header format.
    // sections.join("\\n") inserts a single "\\n" between the two sections;
    // dropping it would cause this test to fail immediately.
    insertStrategicContext(db, 1, "ctx");
    insertLearning(db, 1, "pattern", "a learning");
    const result = formatMemoryForPrompt(db);
    expect(result).toBe(
      "## Strategic Context\nctx\n\n## Key Learnings\n### pattern (1)\n- a learning\n",
    );
  });

  it("always includes strategic context even when it alone exceeds maxChars", () => {
    // Strategic context is priority-0 and is never budget-capped.
    // This test documents that design decision and prevents a future
    // "fix" from accidentally applying the budget cap to it.
    const longContext = "S".repeat(200);
    insertStrategicContext(db, 1, longContext);
    const result = formatMemoryForPrompt(db, 5);
    expect(result).toContain("Strategic Context");
    expect(result).toContain(longContext);
  });

  it("always includes strategic context when maxChars=0 (extreme boundary)", () => {
    // maxChars=0 is the most extreme budget; the invariant that strategic context
    // is never budget-capped must hold even here.  A refactor that naively guards
    // on `totalLen + section.length > maxChars` before emitting strategic context
    // would silently break this invariant.
    const ctx = "Zero-budget context.";
    insertStrategicContext(db, 1, ctx);
    const result = formatMemoryForPrompt(db, 0);
    expect(result).toContain("Strategic Context");
    expect(result).toContain(ctx);
  });

  it("suppresses learnings entirely when maxChars=0 with strategic context present", () => {
    // With maxChars=0 the full budget is consumed by strategic context alone;
    // no learnings header or items should be emitted.
    const ctx = "Zero-budget context string.";
    insertStrategicContext(db, 1, ctx);
    insertLearning(db, 1, "pattern", "Should not appear with zero budget");
    const result = formatMemoryForPrompt(db, 0);
    expect(result).not.toContain("## Key Learnings");
    expect(result).not.toContain("Should not appear with zero budget");
  });

  it("suppresses Key Learnings entirely when strategic context alone exceeds maxChars", () => {
    // When the strategic context section is already over budget the learnings loop
    // must not execute at all — no "## Key Learnings" header and no learning items
    // should appear, even when learnings exist in the DB.
    const longContext = "C".repeat(300);
    insertStrategicContext(db, 1, longContext);
    insertLearning(db, 1, "pattern", "Should never appear");
    // Budget is far smaller than the strategic context section (~320 chars)
    const result = formatMemoryForPrompt(db, 10);
    // Strategic context is always emitted regardless of budget
    expect(result).toContain("Strategic Context");
    // Learnings section must be completely absent
    expect(result).not.toContain("## Key Learnings");
    expect(result).not.toContain("Should never appear");
  });

  it("suppresses learnings when maxChars exactly equals the strategic context section length", () => {
    // Edge case: budget is set to precisely the length of the strategic context section.
    // The learnings loop checks `totalLen + learningSection.length + ... > maxChars`
    // and should break immediately, so no "## Key Learnings" header or items appear.
    const context = "Exact budget test context.";
    insertStrategicContext(db, 1, context);
    insertLearning(db, 1, "pattern", "Should not appear at exact boundary");
    const contextSection = `## Strategic Context\n${context}\n`;
    const result = formatMemoryForPrompt(db, contextSection.length);
    expect(result).toContain("Strategic Context");
    expect(result).toContain(context);
    expect(result).not.toContain("## Key Learnings");
    expect(result).not.toContain("Should not appear at exact boundary");
  });

  it("output.length never exceeds maxChars for tight budgets spanning context and learnings", () => {
    // Regression guard for the sections.join("\\n") separator: when both strategic
    // context and learnings are present, the separator adds 1 char to the output.
    // The budget check must account for it so output.length <= maxChars always holds.
    const context = "Boundary guard context string.";
    insertStrategicContext(db, 1, context);
    insertLearning(db, 1, "pattern", "Pattern item A");
    insertLearning(db, 1, "pattern", "Pattern item B which is a bit longer");
    insertLearning(db, 1, "domain", "Domain item one");

    const fullResult = formatMemoryForPrompt(db, 100000);
    // Test a range of tight budgets near the boundary where learnings get truncated.
    // Skip budgets smaller than the strategic context section alone (strategic context
    // is always emitted regardless of budget — output can exceed maxChars in that case).
    const contextSectionLen = `## Strategic Context\n${context}\n`.length;
    for (let budget = contextSectionLen; budget <= fullResult.length; budget++) {
      const result = formatMemoryForPrompt(db, budget);
      expect(result.length).toBeLessThanOrEqual(budget);
    }
  });

  it("appends ellipsis when learnings section is budget-truncated", () => {
    // No strategic context — all budget goes to the learnings section.
    for (let i = 0; i < 20; i++) {
      insertLearning(db, 1, "pattern", `Pattern item ${i} with enough text to consume budget quickly`);
    }
    const fullResult = formatMemoryForPrompt(db, 100000);
    // Use a budget that truncates mid-list but still leaves room for "…\n" (2 chars).
    // The ellipsis fits when budget >= truncated-output-length + 2, so we try a range
    // of tight budgets and verify that at least one of them produces the ellipsis.
    const budgets = [100, 150, 200, 250, 300];
    let ellipsisFound = false;
    for (const budget of budgets) {
      const result = formatMemoryForPrompt(db, budget);
      if (result.length < fullResult.length && result.includes("…")) {
        ellipsisFound = true;
        // When the ellipsis appears it must be on its own line at the end.
        expect(result.endsWith("…\n")).toBe(true);
        // Output must not exceed budget
        expect(result.length).toBeLessThanOrEqual(budget);
      }
    }
    expect(ellipsisFound).toBe(true);
  });

  it("does not append ellipsis when remaining budget has 0–1 chars headroom after truncation", () => {
    // Pins the guard at memory.ts lines 266-268: the ellipsis ("…\n", 2 chars) is
    // only appended when totalLen + separatorLen + learningSection.length + 2 <= maxChars.
    // When fewer than 2 chars remain after the last fitted learning item, the ellipsis
    // is silently skipped — this path is distinct from the tested "ellipsis fits" path.
    // A sweep over tight budgets finds at least one budget value where truncation
    // occurs but the ellipsis is absent (headroom 0 or 1), exercising the silent branch.
    for (let i = 0; i < 5; i++) {
      insertLearning(db, 1, "pattern", `Item ${i} with some padding text`);
    }
    const fullResult = formatMemoryForPrompt(db, 100000);
    let foundSkippedEllipsis = false;
    for (let budget = 30; budget < fullResult.length; budget++) {
      const result = formatMemoryForPrompt(db, budget);
      // Only inspect budgets that produce a non-empty truncated output
      if (result.length === 0 || result.length === fullResult.length) continue;
      if (!result.includes("…")) {
        foundSkippedEllipsis = true;
        // Budget invariant must still hold even when ellipsis is skipped
        expect(result.length).toBeLessThanOrEqual(budget);
      }
    }
    // The ellipsis-skipped branch must be reachable for some budget value
    expect(foundSkippedEllipsis).toBe(true);
  });

  it("deterministic: ellipsis silently skipped when exactly 1 char of headroom remains after truncation", () => {
    // Insert "B" first (lower relevance after decay), then insert "A" (highest relevance).
    // getRelevantLearnings returns by relevance DESC → "A" is items[0], "B" is items[1].
    insertLearning(db, 1, "pattern", "B");
    decayLearningRelevance(db);           // "B" relevance drops to ~0.95
    insertLearning(db, 1, "pattern", "A"); // "A" relevance = 1.0 → appears first

    // Budget arithmetic (no strategic context → separatorLen=0, totalLen=0):
    //   MEMORY_KEY_LEARNINGS_HEADER = "## Key Learnings\n"       (17 chars)
    //   category header "### pattern (2)\n"                       (16 chars)
    //   first item line "- A\n"                                   ( 4 chars)
    //   → learningSection after fitting "A" = 37 chars
    //
    //   maxChars = 38  →  1 char of headroom after the last fitted item
    //
    //   check "B": 0+0+37+4 = 41 > 38  → budgetExhausted=true
    //   ellipsis:  0+0+37+2 = 39 > 38  → ellipsis NOT appended (silently skipped)
    //   result = "## Key Learnings\n### pattern (2)\n- A\n"  (37 chars, no "…")
    const maxChars =
      MEMORY_KEY_LEARNINGS_HEADER.length  // 17
      + "### pattern (2)\n".length        // 16
      + "- A\n".length                   //  4
      + 1;                               // → 38

    const fullResult = formatMemoryForPrompt(db, 100000);
    const result = formatMemoryForPrompt(db, maxChars);

    expect(result.length).toBeLessThan(fullResult.length); // truncation occurred
    expect(result).not.toContain("…");                     // ellipsis was silently skipped
    expect(result.length).toBeLessThanOrEqual(maxChars);   // budget invariant holds
    expect(result).toContain("- A");                       // highest-relevance item included
    expect(result).not.toContain("- B");                   // lower-relevance item was cut
  });

  it("outputs categories in LEARNING_CATEGORIES declaration order regardless of Map insertion order", () => {
    // formatMemoryForPrompt groups learnings into a Map keyed by category,
    // then iterates LEARNING_CATEGORIES (not the Map) to build output.
    // This test inserts learnings in reverse-category order to verify that
    // the output order always matches LEARNING_CATEGORIES, not insertion order.
    // A regression that switched to iterating the Map would non-deterministically
    // reorder output in environments where Map preserves insertion order (V8).
    insertLearning(db, 1, "process", "A process learning");
    insertLearning(db, 1, "tool-usage", "A tool-usage learning");
    insertLearning(db, 1, "domain", "A domain learning");
    insertLearning(db, 1, "anti-pattern", "An anti-pattern learning");
    insertLearning(db, 1, "pattern", "A pattern learning");

    const result = formatMemoryForPrompt(db, 100000);

    // Verify all five categories appear
    expect(result).toContain("### pattern");
    expect(result).toContain("### anti-pattern");
    expect(result).toContain("### domain");
    expect(result).toContain("### tool-usage");
    expect(result).toContain("### process");

    // Verify order matches LEARNING_CATEGORIES: pattern < anti-pattern < domain < tool-usage < process
    const patternIdx = result.indexOf("### pattern");
    const antiPatternIdx = result.indexOf("### anti-pattern");
    const domainIdx = result.indexOf("### domain");
    const toolUsageIdx = result.indexOf("### tool-usage");
    const processIdx = result.indexOf("### process");

    expect(patternIdx).toBeLessThan(antiPatternIdx);
    expect(antiPatternIdx).toBeLessThan(domainIdx);
    expect(domainIdx).toBeLessThan(toolUsageIdx);
    expect(toolUsageIdx).toBeLessThan(processIdx);
  });

  it("appends ellipsis when outer-loop break fires (second category header+first item exceed budget)", () => {
    // This exercises the outer-loop truncation path: the budget fits the first
    // category entirely but NOT the second category's header + first item combined.
    // Before the fix, budgetExhausted remained false in this case and the ellipsis
    // was silently omitted; the LLM could not tell the list was cut.
    //
    // Use decay to guarantee ordering: domain is inserted first (lower relevance
    // after decay), pattern is inserted second (higher relevance = appears first).
    insertLearning(db, 1, "domain", "A short domain learning"); // inserted first → lower relevance after decay
    decayLearningRelevance(db);                                  // domain relevance drops to ~0.95
    insertLearning(db, 1, "pattern", "A short pattern learning"); // inserted second → relevance 1.0 → appears first

    // Full output: ## Key Learnings\n + ### pattern(1)\n + - A short pattern learning\n
    //               + ### domain(1)\n + - A short domain learning\n
    // Budget that fits pattern section but NOT domain header + first item together:
    const patternSection =
      MEMORY_KEY_LEARNINGS_HEADER +
      "### pattern (1)\n" +
      "- A short pattern learning\n";
    const budget = patternSection.length + 5; // fits pattern but not domain header+item

    const fullResult = formatMemoryForPrompt(db, 100000);
    const result = formatMemoryForPrompt(db, budget);

    // The result must be shorter than the full output (domain category omitted)
    expect(result.length).toBeLessThan(fullResult.length);
    // The result must contain the pattern learning (first category — fits)
    expect(result).toContain("A short pattern learning");
    // The result must NOT contain the domain learning (second category — cut by outer break)
    expect(result).not.toContain("A short domain learning");
    // The ellipsis must appear at the end to signal truncation
    expect(result.endsWith("…\n")).toBe(true);
    // Output must not exceed budget
    expect(result.length).toBeLessThanOrEqual(budget);
  });

  it("result.length <= maxChars invariant holds across a range of tight budgets (multi-category + strategic context)", () => {
    // Parametric regression guard for the separator + multi-section budget accounting.
    // Inserts strategic context and learnings across all five categories, then sweeps
    // tight budgets from just above the strategic context section length up to full
    // output length and asserts result.length <= budget at every step.
    insertStrategicContext(db, 1, "Parametric boundary context string for invariant test.");
    insertLearning(db, 1, "pattern",      "Pattern insight for budget test");
    insertLearning(db, 1, "anti-pattern", "Anti-pattern insight for budget test");
    insertLearning(db, 1, "domain",       "Domain insight for budget test");
    insertLearning(db, 1, "tool-usage",   "Tool-usage insight for budget test");
    insertLearning(db, 1, "process",      "Process insight for budget test");

    const context = "Parametric boundary context string for invariant test.";
    const contextSectionLen = `## Strategic Context\n${context}\n`.length;
    const fullResult = formatMemoryForPrompt(db, 100000);

    // Skip budgets below contextSectionLen: strategic context is always emitted
    // regardless of budget, so output can legitimately exceed maxChars there.
    for (let budget = contextSectionLen; budget <= fullResult.length + 5; budget++) {
      const result = formatMemoryForPrompt(db, budget);
      expect(result.length).toBeLessThanOrEqual(budget);
    }
  });

  it("truncated output always ends on a clean newline boundary (no mid-line cuts)", () => {
    // Regression guard: budget-aware truncation must stop at whole-line boundaries,
    // never slicing a learning item mid-text. Each included line ends with \n,
    // so the final output must end with \n (or be empty).
    insertStrategicContext(db, 1, "Focus on reliability.");
    for (let i = 0; i < 30; i++) {
      insertLearning(db, 1, "pattern", `Pattern item ${i}: important insight about the codebase`);
    }
    // Try several tight budgets to cover boundary conditions
    const budgets = [50, 100, 150, 200, 300, 500];
    for (const budget of budgets) {
      const result = formatMemoryForPrompt(db, budget);
      if (result.length > 0) {
        expect(result.endsWith("\n"), `Output for budget=${budget} should end with \\n but got: "${result.slice(-20)}"`).toBe(true);
      }
    }
  });

  it("category sections appear in LEARNING_CATEGORIES order regardless of DB insertion order", () => {
    // Insert one learning per category in REVERSED LEARNING_CATEGORIES order so
    // higher DB ids (and thus higher relevance-tiebreaker ranks) belong to
    // categories that should appear LAST. Without the LEARNING_CATEGORIES-order
    // fix, Map insertion order would produce the reversed sequence.
    const reversed = [...LEARNING_CATEGORIES].reverse();
    for (const cat of reversed) {
      insertLearning(db, 1, cat, `A ${cat} insight`);
    }
    const result = formatMemoryForPrompt(db, 100000);
    // Collect the category names from "### <name> (N)" headers in output order.
    const headerMatches = [...result.matchAll(/^### ([\w-]+) \(\d+\)/gm)];
    const outputCategories = headerMatches.map((m) => m[1]);
    // Filter LEARNING_CATEGORIES to those that appear in the output (all should).
    const expectedOrder = LEARNING_CATEGORIES.filter((c) => outputCategories.includes(c));
    expect(outputCategories).toEqual(expectedOrder);
  });
});

describe("storeStrategicContext", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
  });

  it("stores and retrieves strategic context via memory module", () => {
    storeStrategicContext(db, 1, "Focusing on test coverage.");
    expect(getLatestStrategicContext(db)).toBe("Focusing on test coverage.");
  });

  it("overwrites earlier context when storing for a later cycle", () => {
    storeStrategicContext(db, 1, "Old focus.");
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    storeStrategicContext(db, 2, "New focus.");
    expect(getLatestStrategicContext(db)).toBe("New focus.");
  });

  it("formatMemoryForPrompt reflects only the latest strategic context", () => {
    storeStrategicContext(db, 1, "Initial strategy.");
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    storeStrategicContext(db, 2, "Updated strategy.");
    const result = formatMemoryForPrompt(db);
    expect(result).toContain("Updated strategy.");
    expect(result).not.toContain("Initial strategy.");
  });

  it("formatMemoryForPrompt shows newest context after three overwrites", () => {
    storeStrategicContext(db, 1, "First context.");
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    storeStrategicContext(db, 2, "Second context.");
    insertCycle(db, makeOutcome({ cycleNumber: 3 }));
    storeStrategicContext(db, 3, "Third context.");
    const result = formatMemoryForPrompt(db);
    expect(result).toContain("Third context.");
    expect(result).not.toContain("First context.");
    expect(result).not.toContain("Second context.");
  });

  it("prunes old strategic context rows to keep only the most recent 20", () => {
    // Insert 25 contexts across 25 cycles
    for (let i = 1; i <= 25; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
      storeStrategicContext(db, i, `Context for cycle ${i}`);
    }
    // Only 20 rows should remain after pruning
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM strategic_context").get() as { cnt: number }).cnt;
    expect(count).toBeLessThanOrEqual(20);
    // Latest context must still be accessible
    expect(getLatestStrategicContext(db)).toBe("Context for cycle 25");
  });

  it("prunes exactly 1 row when 21st entry is inserted (fencepost boundary)", () => {
    // After 20 entries, the table is at the limit; the 21st must evict exactly
    // the oldest row — verifying there's no off-by-one error in the pruning SQL.
    for (let i = 1; i <= 21; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
      storeStrategicContext(db, i, `Context for cycle ${i}`);
    }
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM strategic_context").get() as { cnt: number }).cnt;
    expect(count).toBe(20);
    // The oldest (cycle 1) must have been evicted
    const rows = db.prepare("SELECT summary FROM strategic_context ORDER BY cycle_number ASC").all() as { summary: string }[];
    expect(rows[0].summary).toBe("Context for cycle 2");
    expect(getLatestStrategicContext(db)).toBe("Context for cycle 21");
  });
});

describe("DB functions for memory", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
  });

  it("creates learnings and strategic_context tables", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain("learnings");
    expect(names).toContain("strategic_context");
  });

  it("getRelevantLearnings filters by category", () => {
    insertLearning(db, 1, "pattern", "Pattern learning");
    insertLearning(db, 1, "domain", "Domain learning");
    const patterns = getRelevantLearnings(db, 10, "pattern");
    expect(patterns).toHaveLength(1);
    expect(patterns[0].content).toBe("Pattern learning");
  });

  it("getRelevantLearnings orders by relevance DESC", () => {
    insertLearning(db, 1, "domain", "First");
    decayLearningRelevance(db);
    insertLearning(db, 2, "domain", "Second");
    const learnings = getRelevantLearnings(db, 10);
    expect(learnings[0].content).toBe("Second");
    expect(learnings[0].relevance).toBe(1.0);
    expect(learnings[1].content).toBe("First");
    expect(learnings[1].relevance).toBeLessThan(1.0);
  });

  it("decayLearningRelevance reduces relevance", () => {
    insertLearning(db, 1, "domain", "Test learning");
    decayLearningRelevance(db, 0.5);
    const learnings = getRelevantLearnings(db, 10);
    expect(learnings[0].relevance).toBeCloseTo(0.5);
  });

  it("decayLearningRelevance applies per-category rates when called without explicit factor", () => {
    insertLearning(db, 1, "pattern", "Architectural insight");
    insertLearning(db, 1, "tool-usage", "Tool tip");
    decayLearningRelevance(db); // use per-category rates
    const all = getRelevantLearnings(db, 10);
    const pattern = all.find(l => l.content === "Architectural insight")!;
    const toolUsage = all.find(l => l.content === "Tool tip")!;
    // pattern (0.98) should decay slower than tool-usage (0.93)
    expect(pattern.relevance).toBeCloseTo(0.98);
    expect(toolUsage.relevance).toBeCloseTo(0.93);
    expect(pattern.relevance).toBeGreaterThan(toolUsage.relevance);
  });

  it.each([
    ["pattern",      0.98],
    ["anti-pattern", 0.97],
    ["domain",       0.95],
    ["process",      0.93],
    ["tool-usage",   0.93],
  ] as const)(
    "decayLearningRelevance: '%s' category decays from 1.0 to exactly %s after one cycle",
    (category, expectedRate) => {
      insertLearning(db, 1, category, `${category} learning`);
      decayLearningRelevance(db); // per-category rates, no explicit factor
      const rows = db.prepare("SELECT relevance FROM learnings WHERE category = ?").all(category) as { relevance: number }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].relevance).toBeCloseTo(expectedRate, 5);
    },
  );

  it("decayLearningRelevance falls back to 0.95 for unknown categories", () => {
    // Insert a learning with a category not in DECAY_BY_CATEGORY via raw SQL
    db.prepare("INSERT INTO learnings (cycle_number, category, content) VALUES (?, ?, ?)").run(1, "unknown-cat", "Mystery learning");
    decayLearningRelevance(db); // per-category path
    const rows = db.prepare("SELECT relevance FROM learnings WHERE category = 'unknown-cat'").all() as { relevance: number }[];
    expect(rows[0].relevance).toBeCloseTo(0.95);
  });

  it("pruneLowRelevanceLearnings removes entries below threshold", () => {
    insertLearning(db, 1, "domain", "Keep me");
    insertLearning(db, 1, "domain", "Prune me");
    // Decay once to drop all to 0.95, then once more to drop to ~0.90
    decayLearningRelevance(db, 0.95);
    // Now manually decay the second entry further by updating directly
    // Instead: insert at low relevance by decaying heavily
    decayLearningRelevance(db, 0.04); // now all are ~0.038 — below 0.05
    pruneLowRelevanceLearnings(db, 0.05);
    expect(getRelevantLearnings(db, 10)).toHaveLength(0);
  });

  it("pruneLowRelevanceLearnings keeps entries at or above threshold", () => {
    insertLearning(db, 1, "domain", "High relevance");
    // Default relevance is 1.0 — well above 0.05
    pruneLowRelevanceLearnings(db, 0.05);
    const remaining = getRelevantLearnings(db, 10);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe("High relevance");
  });

  it("pruneLowRelevanceLearnings only removes entries strictly below threshold", () => {
    insertLearning(db, 1, "domain", "Exactly at threshold");
    decayLearningRelevance(db, 0.05); // relevance = 0.05 exactly
    pruneLowRelevanceLearnings(db, 0.05); // threshold is < 0.05, so 0.05 should stay
    expect(getRelevantLearnings(db, 10)).toHaveLength(1);
  });

  it("deduplicates learnings that differ only by leading/trailing whitespace", () => {
    // First store a learning with clean content
    storeLearnings(db, 1, { learnings: [{ category: "pattern", content: "Always write tests first" }] });
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    // Then attempt to store the same learning with surrounding whitespace
    const { count: count1 } = storeLearnings(db, 2, { learnings: [{ category: "pattern", content: "  Always write tests first  " }] });
    expect(count1).toBe(0);
    expect(getRelevantLearnings(db, 10)).toHaveLength(1);
  });

  it("deduplicates learnings that differ only by capitalisation", () => {
    // First store with lowercase
    storeLearnings(db, 1, { learnings: [{ category: "domain", content: "use explicit return types" }] });
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    // Then attempt to store with capital first letter
    const { count: count2 } = storeLearnings(db, 2, { learnings: [{ category: "domain", content: "Use explicit return types" }] });
    expect(count2).toBe(0);
    expect(getRelevantLearnings(db, 10)).toHaveLength(1);
  });

  it("stores content trimmed of whitespace", () => {
    storeLearnings(db, 1, { learnings: [{ category: "pattern", content: "  Trimmed learning  " }] });
    const learnings = getRelevantLearnings(db, 10);
    expect(learnings).toHaveLength(1);
    expect(learnings[0].content).toBe("Trimmed learning");
  });

  it("storeLearnings prunes low-relevance entries after decaying", () => {
    // Insert a learning and decay it far below the prune threshold
    insertLearning(db, 1, "domain", "Very old learning");
    decayLearningRelevance(db, 0.01); // relevance = 0.01 — below 0.05
    // storeLearnings should decay + prune + insert new
    storeLearnings(db, 2, { learnings: [{ category: "pattern", content: "Fresh learning" }] });
    const remaining = getRelevantLearnings(db, 10);
    // Old entry (0.01 * 0.95 = ~0.0095) is pruned; fresh entry has relevance 1.0
    expect(remaining.every(l => l.content !== "Very old learning")).toBe(true);
    expect(remaining.some(l => l.content === "Fresh learning")).toBe(true);
  });

  it("getLatestStrategicContext returns null when empty", () => {
    expect(getLatestStrategicContext(db)).toBeNull();
  });

  it("getLatestStrategicContext returns most recent", () => {
    insertStrategicContext(db, 1, "Old context");
    insertStrategicContext(db, 2, "New context");
    expect(getLatestStrategicContext(db)).toBe("New context");
  });
});

describe("MAX_MEMORY_CHARS", () => {
  it("is a positive integer", () => {
    expect(typeof MAX_MEMORY_CHARS).toBe("number");
    expect(Number.isInteger(MAX_MEMORY_CHARS)).toBe(true);
    expect(MAX_MEMORY_CHARS).toBeGreaterThan(0);
  });

  it("is 1200 (value-pinning)", () => {
    expect(MAX_MEMORY_CHARS).toBe(1200);
  });
});

describe("STRATEGIC_CONTEXT_RETENTION_CYCLES", () => {
  it("is 20 (value-pinning)", () => {
    expect(STRATEGIC_CONTEXT_RETENTION_CYCLES).toBe(20);
  });
});

describe("MAX_RELEVANT_LEARNINGS_TO_FETCH", () => {
  it("is 25 (value-pinning)", () => {
    expect(MAX_RELEVANT_LEARNINGS_TO_FETCH).toBe(25);
  });
});

describe("MEMORY_STRATEGIC_CONTEXT_HEADER", () => {
  it("equals '## Strategic Context\\n' (value-pinning)", () => {
    expect(MEMORY_STRATEGIC_CONTEXT_HEADER).toBe("## Strategic Context\n");
  });
});

describe("MEMORY_KEY_LEARNINGS_HEADER", () => {
  it("equals '## Key Learnings\\n' (value-pinning)", () => {
    expect(MEMORY_KEY_LEARNINGS_HEADER).toBe("## Key Learnings\n");
  });
});

describe("LEARNING_CATEGORIES", () => {
  it("contains exactly the expected category values (value-pinning)", () => {
    expect(LEARNING_CATEGORIES).toEqual(["pattern", "anti-pattern", "domain", "tool-usage", "process"]);
  });
});
