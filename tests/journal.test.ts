import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initDb, insertCycle, insertJournalEntry } from "../src/db.js";
import {
  generateJournalOutput,
  formatJournalMarkdown,
  parseArgs,
  JOURNAL_ATTEMPTED_HEADER,
  JOURNAL_SUCCEEDED_HEADER,
  JOURNAL_FAILED_HEADER,
  JOURNAL_LEARNINGS_HEADER,
  JOURNAL_STRATEGIC_CONTEXT_HEADER,
} from "../src/journal.js";
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

  it("returns all entries when limit is 0", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertJournalEntry(db, 1, "attempted", "Entry 1");
    insertJournalEntry(db, 2, "attempted", "Entry 2");

    const output = generateJournalOutput(db, { limit: 0 });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
  });

  it("returns all entries when limit is negative", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertJournalEntry(db, 1, "attempted", "Entry 1");
    insertJournalEntry(db, 2, "attempted", "Entry 2");

    const output = generateJournalOutput(db, { limit: -1 });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
  });

  it("floors fractional limit (3.7 behaves like 3)", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertCycle(db, makeOutcome({ cycleNumber: 3 }));
    insertCycle(db, makeOutcome({ cycleNumber: 4 }));
    insertJournalEntry(db, 1, "attempted", "Entry 1");
    insertJournalEntry(db, 2, "attempted", "Entry 2");
    insertJournalEntry(db, 3, "attempted", "Entry 3");
    insertJournalEntry(db, 4, "attempted", "Entry 4");

    const output = generateJournalOutput(db, { limit: 3.7 });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(3);
  });

  it("treats fractional limit below 1 (0.5) as no limit", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertJournalEntry(db, 1, "attempted", "Entry 1");
    insertJournalEntry(db, 2, "attempted", "Entry 2");

    const output = generateJournalOutput(db, { limit: 0.5 });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
  });
});

describe("journal header constants (value-pinning)", () => {
  it("JOURNAL_ATTEMPTED_HEADER is '### What was attempted'", () => {
    expect(JOURNAL_ATTEMPTED_HEADER).toBe("### What was attempted");
  });
  it("JOURNAL_SUCCEEDED_HEADER is '### What succeeded'", () => {
    expect(JOURNAL_SUCCEEDED_HEADER).toBe("### What succeeded");
  });
  it("JOURNAL_FAILED_HEADER is '### What failed'", () => {
    expect(JOURNAL_FAILED_HEADER).toBe("### What failed");
  });
  it("JOURNAL_LEARNINGS_HEADER is '### Learnings'", () => {
    expect(JOURNAL_LEARNINGS_HEADER).toBe("### Learnings");
  });
  it("JOURNAL_STRATEGIC_CONTEXT_HEADER is '### Strategic Context'", () => {
    expect(JOURNAL_STRATEGIC_CONTEXT_HEADER).toBe("### Strategic Context");
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
    expect(output).toContain(JOURNAL_ATTEMPTED_HEADER);
    expect(output).toContain(JOURNAL_STRATEGIC_CONTEXT_HEADER);
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
    expect(output).toContain(JOURNAL_ATTEMPTED_HEADER);
    expect(output).not.toContain(JOURNAL_SUCCEEDED_HEADER);
    expect(output).not.toContain(JOURNAL_FAILED_HEADER);
  });

  it("emits only heading and separator when all optional fields are empty strings", () => {
    const entries = [
      {
        cycleNumber: 1,
        date: "2026-01-01",
        attempted: "",
        succeeded: "",
        failed: "",
        learnings: "",
        strategic_context: "",
      },
    ];
    const output = formatJournalMarkdown(entries);
    expect(output).toContain("## Cycle 1 — 2026-01-01");
    expect(output).toContain("---");
    expect(output).not.toContain(JOURNAL_ATTEMPTED_HEADER);
    expect(output).not.toContain(JOURNAL_SUCCEEDED_HEADER);
    expect(output).not.toContain(JOURNAL_FAILED_HEADER);
    expect(output).not.toContain(JOURNAL_LEARNINGS_HEADER);
    expect(output).not.toContain(JOURNAL_STRATEGIC_CONTEXT_HEADER);
  });

  it("single no-field entry produces exactly 6 lines (structural pin)", () => {
    // Structure: ["# Bloom Evolution Journal", ""] (2)
    //   + heading + blank (2) + "---" + blank (2) = 6
    const entries = [
      {
        cycleNumber: 1,
        date: "2026-01-01",
        attempted: "",
        succeeded: "",
        failed: "",
        learnings: "",
        strategic_context: "",
      },
    ];
    const output = formatJournalMarkdown(entries);
    expect(output).toBe(
      "# Bloom Evolution Journal\n\n## Cycle 1 — 2026-01-01\n\n---\n",
    );
    const lines = output.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("# Bloom Evolution Journal");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("## Cycle 1 — 2026-01-01");
    expect(lines[4]).toBe("---");
  });

  it("single 1-field entry produces exactly 9 lines (structural pin)", () => {
    // Structure: doc-header (2) + heading + blank (2)
    //   + 1 × (header + content + blank) (3) + "---" + blank (2) = 9
    const entries = [
      {
        cycleNumber: 2,
        date: "2026-02-01",
        attempted: "Add a feature",
        succeeded: "",
        failed: "",
        learnings: "",
        strategic_context: "",
      },
    ];
    const lines = formatJournalMarkdown(entries).split("\n");
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe("# Bloom Evolution Journal");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("## Cycle 2 — 2026-02-01");
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
    // Structural pin: doc header (2) + entry1 attempted-only (7) + entry2 attempted+succeeded (10) = 19 lines
    const lines = output.split("\n");
    expect(lines).toHaveLength(19);
    expect(lines[0]).toBe("# Bloom Evolution Journal");
    expect(lines[2]).toBe("## Cycle 1 — 2025-01-01");
  });

  it("produces exactly N '---' separators for N entries", () => {
    const entries = [
      {
        cycleNumber: 1,
        date: "2025-01-01",
        attempted: "Alpha",
        succeeded: "Done",
        failed: "",
        learnings: "",
        strategic_context: "",
      },
      {
        cycleNumber: 2,
        date: "2025-01-02",
        attempted: "Beta",
        succeeded: "",
        failed: "Oops",
        learnings: "Lesson",
        strategic_context: "Stay focused",
      },
    ];
    const output = formatJournalMarkdown(entries);
    // Count standalone '---' separator lines (not part of other content)
    const separatorCount = output.split("\n").filter((line) => line === "---").length;
    expect(separatorCount).toBe(2);
  });

  it("single all-fields entry produces exactly 21 lines with title at [0] and blank at [1]", () => {
    // Structure: ["# Bloom Evolution Journal", ""] (2)
    //   + heading + blank (2) + 5 × (header + content + blank) (15) + "---" + blank (2) = 21
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
    const lines = output.split("\n");
    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe("# Bloom Evolution Journal");
    expect(lines[1]).toBe("");
  });

  it("renders sections in the correct order: attempted, succeeded, failed, learnings, strategic_context", () => {
    const entries = [
      {
        cycleNumber: 1,
        date: "2025-01-01",
        attempted: "ATTEMPTED_TEXT",
        succeeded: "SUCCEEDED_TEXT",
        failed: "FAILED_TEXT",
        learnings: "LEARNINGS_TEXT",
        strategic_context: "STRATEGIC_TEXT",
      },
    ];
    const output = formatJournalMarkdown(entries);
    const idxAttempted = output.indexOf("ATTEMPTED_TEXT");
    const idxSucceeded = output.indexOf("SUCCEEDED_TEXT");
    const idxFailed = output.indexOf("FAILED_TEXT");
    const idxLearnings = output.indexOf("LEARNINGS_TEXT");
    const idxStrategic = output.indexOf("STRATEGIC_TEXT");
    expect(idxAttempted).toBeLessThan(idxSucceeded);
    expect(idxSucceeded).toBeLessThan(idxFailed);
    expect(idxFailed).toBeLessThan(idxLearnings);
    expect(idxLearnings).toBeLessThan(idxStrategic);
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
