import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initDb, insertCycle, insertJournalEntry } from "../src/db.js";
import { generateJournalOutput, formatJournalMarkdown } from "../src/journal.js";
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
});
