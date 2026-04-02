import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initDb, insertCycle, insertJournalEntry } from "../src/db.js";
import { generateJournalOutput, formatJournalMarkdown, parseArgs } from "../src/journal.js";
import { makeOutcome } from "./helpers.js";

describe("generateJournalOutput", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("returns empty JSON array when no entries exist", () => {
    const output = generateJournalOutput(db);
    expect(JSON.parse(output)).toEqual([]);
  });

  it("returns journal entries as JSON by default", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertJournalEntry(db, 1, "attempted", "Improve tests");
    insertJournalEntry(db, 1, "succeeded", "Added 3 tests");

    const output = generateJournalOutput(db);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].cycleNumber).toBe(1);
    expect(parsed[0].attempted).toBe("Improve tests");
    expect(parsed[0].succeeded).toBe("Added 3 tests");
  });

  it("returns Markdown when format is md", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertJournalEntry(db, 1, "attempted", "Fix bug");
    insertJournalEntry(db, 1, "succeeded", "Bug fixed");

    const output = generateJournalOutput(db, { format: "md" });
    expect(output).toContain("# Bloom Evolution Journal");
    expect(output).toContain("## Cycle 1");
    expect(output).toContain("Fix bug");
    expect(output).toContain("Bug fixed");
  });

  it("respects limit option", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertCycle(db, makeOutcome({ cycleNumber: 3 }));
    insertJournalEntry(db, 1, "attempted", "Entry 1");
    insertJournalEntry(db, 2, "attempted", "Entry 2");
    insertJournalEntry(db, 3, "attempted", "Entry 3");

    const output = generateJournalOutput(db, { limit: 2 });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
  });
});

describe("formatJournalMarkdown", () => {
  it("returns message when no entries exist", () => {
    expect(formatJournalMarkdown([])).toBe("No journal entries recorded yet.");
  });

  it("formats entries with all sections", () => {
    const entries = [
      {
        cycleNumber: 5,
        date: "2025-01-15",
        attempted: "Add feature",
        succeeded: "Feature added",
        failed: "Nothing",
        learnings: "Learned something",
        strategic_context: "Focus on testing",
      },
    ];
    const output = formatJournalMarkdown(entries);
    expect(output).toContain("## Cycle 5 — 2025-01-15");
    expect(output).toContain("### What was attempted");
    expect(output).toContain("### Strategic Context");
  });

  it("omits empty sections", () => {
    const entries = [
      {
        cycleNumber: 1,
        date: "2025-01-01",
        attempted: "Something",
        succeeded: "",
        failed: "",
        learnings: "",
        strategic_context: "",
      },
    ];
    const output = formatJournalMarkdown(entries);
    expect(output).toContain("### What was attempted");
    expect(output).not.toContain("### What succeeded");
    expect(output).not.toContain("### What failed");
  });

  it("renders multiple entries with separators and correct cycle headers", () => {
    const entries = [
      {
        cycleNumber: 1,
        date: "2025-01-01",
        attempted: "First attempt",
        succeeded: "",
        failed: "",
        learnings: "",
        strategic_context: "",
      },
      {
        cycleNumber: 2,
        date: "2025-01-02",
        attempted: "Second attempt",
        succeeded: "It worked",
        failed: "",
        learnings: "",
        strategic_context: "",
      },
    ];
    const output = formatJournalMarkdown(entries);
    expect(output).toContain("## Cycle 1 — 2025-01-01");
    expect(output).toContain("## Cycle 2 — 2025-01-02");
    expect(output).toContain("First attempt");
    expect(output).toContain("Second attempt");
    expect(output).toContain("---");
  });
});

describe("parseArgs", () => {
  it("returns json format by default with no limit", () => {
    const result = parseArgs([]);
    expect(result).toEqual({ format: "json", limit: undefined });
  });

  it("returns md format when --md is passed", () => {
    const result = parseArgs(["--md"]);
    expect(result).toEqual({ format: "md", limit: undefined });
  });

  it("parses --limit with a valid number", () => {
    const result = parseArgs(["--limit", "5"]);
    expect(result).toEqual({ format: "json", limit: 5 });
  });

  it("handles combined --md and --limit", () => {
    const result = parseArgs(["--md", "--limit", "3"]);
    expect(result).toEqual({ format: "md", limit: 3 });
  });

  it("ignores --limit with NaN value", () => {
    const result = parseArgs(["--limit", "abc"]);
    expect(result).toEqual({ format: "json", limit: undefined });
  });

  it("ignores --limit with no following argument", () => {
    const result = parseArgs(["--limit"]);
    expect(result).toEqual({ format: "json", limit: undefined });
  });

  it("treats --limit 0 as undefined (no limit)", () => {
    const result = parseArgs(["--limit", "0"]);
    expect(result).toEqual({ format: "json", limit: undefined });
  });

  it("handles negative --limit as undefined", () => {
    const result = parseArgs(["--limit", "-1"]);
    expect(result).toEqual({ format: "json", limit: undefined });
  });
});
