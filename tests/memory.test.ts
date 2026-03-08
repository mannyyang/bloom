import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { initDb, insertCycle, insertLearning, getRelevantLearnings, decayLearningRelevance, insertStrategicContext, getLatestStrategicContext } from "../src/db.js";
import { extractLearnings, storeLearnings, parseStrategicContext, formatMemoryForPrompt } from "../src/memory.js";
import { makeOutcome } from "./helpers.js";

describe("extractLearnings", () => {
  it("returns empty for blank input", () => {
    expect(extractLearnings("")).toEqual({ learnings: [] });
    expect(extractLearnings("   ")).toEqual({ learnings: [] });
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

  it("ignores unknown category prefixes", () => {
    const text = "- [unknown] Some insight";
    const result = extractLearnings(text);
    expect(result.learnings).toHaveLength(1);
    expect(result.learnings[0].category).toBe("domain");
    expect(result.learnings[0].content).toBe("[unknown] Some insight");
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
});

describe("parseStrategicContext", () => {
  it("extracts from STRATEGIC_CONTEXT: line", () => {
    const text = "LEARNINGS: stuff\nSTRATEGIC_CONTEXT: I am focusing on test coverage and reliability.";
    expect(parseStrategicContext(text)).toBe("I am focusing on test coverage and reliability.");
  });

  it("extracts from **STRATEGIC_CONTEXT**: format", () => {
    const text = "**STRATEGIC_CONTEXT**: Improving code clarity across modules.";
    expect(parseStrategicContext(text)).toBe("Improving code clarity across modules.");
  });

  it("extracts from **STRATEGIC_CONTEXT:** format", () => {
    const text = "**STRATEGIC_CONTEXT:** Working on error handling improvements.";
    expect(parseStrategicContext(text)).toBe("Working on error handling improvements.");
  });

  it("returns null when section is missing", () => {
    const text = "ATTEMPTED: something\nSUCCEEDED: it worked";
    expect(parseStrategicContext(text)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseStrategicContext("")).toBeNull();
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
    expect(result.length).toBeLessThanOrEqual(400); // some tolerance for the last item
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

  it("includes both strategic context and learnings", () => {
    insertStrategicContext(db, 1, "Building test infrastructure.");
    insertLearning(db, 1, "pattern", "Small incremental changes work best");
    const result = formatMemoryForPrompt(db);
    expect(result).toContain("Strategic Context");
    expect(result).toContain("Key Learnings");
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

  it("getLatestStrategicContext returns null when empty", () => {
    expect(getLatestStrategicContext(db)).toBeNull();
  });

  it("getLatestStrategicContext returns most recent", () => {
    insertStrategicContext(db, 1, "Old context");
    insertStrategicContext(db, 2, "New context");
    expect(getLatestStrategicContext(db)).toBe("New context");
  });
});
