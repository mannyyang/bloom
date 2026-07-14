import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initDb, insertCycle, insertJournalEntry } from "../src/db.js";
import {
  generateJournalOutput,
  generateJournalCsv,
  generateJournalTable,
  formatJournalMarkdown,
  parseArgs,
  JOURNAL_ATTEMPTED_HEADER,
  JOURNAL_SUCCEEDED_HEADER,
  JOURNAL_FAILED_HEADER,
  JOURNAL_LEARNINGS_HEADER,
  JOURNAL_STRATEGIC_CONTEXT_HEADER,
  JOURNAL_HELP_TEXT,
  JOURNAL_CSV_HEADER,
} from "../src/journal.js";
import type { JournalExportEntry } from "../src/db.js";
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

  it("filters entries by since cycle (returns only entries >= since)", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 10 }));
    insertCycle(db, makeOutcome({ cycleNumber: 20 }));
    insertCycle(db, makeOutcome({ cycleNumber: 30 }));
    insertJournalEntry(db, 10, "attempted", "Entry 10");
    insertJournalEntry(db, 20, "attempted", "Entry 20");
    insertJournalEntry(db, 30, "attempted", "Entry 30");

    const output = generateJournalOutput(db, { since: 20 });
    const parsed = JSON.parse(output) as Array<{ cycleNumber: number }>;
    expect(parsed).toHaveLength(2);
    expect(parsed.map((e) => e.cycleNumber).sort((a, b) => a - b)).toEqual([20, 30]);
  });

  it("since filter with exact boundary includes the since cycle itself", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 5 }));
    insertCycle(db, makeOutcome({ cycleNumber: 6 }));
    insertJournalEntry(db, 5, "attempted", "Entry 5");
    insertJournalEntry(db, 6, "attempted", "Entry 6");

    const output = generateJournalOutput(db, { since: 5 });
    const parsed = JSON.parse(output) as Array<{ cycleNumber: number }>;
    expect(parsed).toHaveLength(2);
  });

  it("since filter with value higher than all cycles returns empty array", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertJournalEntry(db, 1, "attempted", "Entry 1");

    const output = generateJournalOutput(db, { since: 999 });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(0);
  });

  it("--limit applies to the since-filtered set, not the unfiltered fetch", () => {
    // Cycles 1-10 exist; since=8 means only cycles 8, 9, 10 qualify.
    // limit=2 should return 2 entries from the filtered set (cycles 9 and 10),
    // not 2 entries from an unfiltered fetch that are then filtered.
    for (let i = 1; i <= 10; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
      insertJournalEntry(db, i, "attempted", `Entry ${i}`);
    }

    const output = generateJournalOutput(db, { limit: 2, since: 8 });
    const parsed = JSON.parse(output) as Array<{ cycleNumber: number }>;
    expect(parsed).toHaveLength(2);
    const cycleNumbers = parsed.map((e) => e.cycleNumber).sort((a, b) => b - a);
    expect(cycleNumbers[0]).toBe(10);
    expect(cycleNumbers[1]).toBe(9);
  });

  it("since 0 is treated as no filter (returns all entries)", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertJournalEntry(db, 1, "attempted", "Entry 1");
    insertJournalEntry(db, 2, "attempted", "Entry 2");

    const output = generateJournalOutput(db, { since: 0 });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
  });

  it("--cycle N returns exactly the entry for that cycle", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 10 }));
    insertCycle(db, makeOutcome({ cycleNumber: 20 }));
    insertCycle(db, makeOutcome({ cycleNumber: 30 }));
    insertJournalEntry(db, 10, "attempted", "Entry 10");
    insertJournalEntry(db, 20, "attempted", "Entry 20");
    insertJournalEntry(db, 30, "attempted", "Entry 30");

    const output = generateJournalOutput(db, { cycle: 20 });
    const parsed = JSON.parse(output) as Array<{ cycleNumber: number }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].cycleNumber).toBe(20);
  });

  it("--cycle N returns empty array when that cycle does not exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertJournalEntry(db, 1, "attempted", "Entry 1");

    const output = generateJournalOutput(db, { cycle: 999 });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(0);
  });

  it("--cycle 0 is treated as no filter (returns all entries)", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertJournalEntry(db, 1, "attempted", "Entry 1");
    insertJournalEntry(db, 2, "attempted", "Entry 2");

    const output = generateJournalOutput(db, { cycle: 0 });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
  });

  it("cycle: undefined is treated as no filter (returns all entries)", () => {
    // Mirrors the --cycle 0 guard test, but pins the undefined path
    // that parseIntArg returns when --cycle is absent or invalid.
    // safeCycle = cycle > 0 ? cycle : undefined → undefined skips the WHERE clause.
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertJournalEntry(db, 1, "attempted", "Entry 1");
    insertJournalEntry(db, 2, "attempted", "Entry 2");

    const output = generateJournalOutput(db, { cycle: undefined });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
  });

  it("format md with since filter omits cycles before since boundary", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 5 }));
    insertCycle(db, makeOutcome({ cycleNumber: 15 }));
    insertCycle(db, makeOutcome({ cycleNumber: 25 }));
    insertJournalEntry(db, 5, "attempted", "Cycle 5 work");
    insertJournalEntry(db, 15, "attempted", "Cycle 15 work");
    insertJournalEntry(db, 25, "attempted", "Cycle 25 work");

    const output = generateJournalOutput(db, { format: "md", since: 15 });
    expect(output).toContain("## Cycle 15");
    expect(output).toContain("## Cycle 25");
    expect(output).not.toContain("## Cycle 5");
    // Both qualifying cycles have their content
    expect(output).toContain("Cycle 15 work");
    expect(output).toContain("Cycle 25 work");
    expect(output).not.toContain("Cycle 5 work");
  });

  it("returns CSV when format is csv", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertJournalEntry(db, 1, "attempted", "Some work");
    const output = generateJournalOutput(db, { format: "csv" });
    expect(output).toContain("cycleNumber,date,attempted");
    expect(output).toContain("Some work");
  });

  it("--cycle N with format md returns Markdown for exactly that cycle", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 5 }));
    insertCycle(db, makeOutcome({ cycleNumber: 10 }));
    insertJournalEntry(db, 5, "attempted", "Cycle 5 work");
    insertJournalEntry(db, 10, "attempted", "Cycle 10 work");

    const output = generateJournalOutput(db, { format: "md", cycle: 5 });
    expect(output).toContain("## Cycle 5");
    expect(output).toContain("Cycle 5 work");
    expect(output).not.toContain("## Cycle 10");
  });
});

describe("JOURNAL_HELP_TEXT (value-pinning)", () => {
  it("contains 'Usage: pnpm journal'", () => {
    expect(JOURNAL_HELP_TEXT).toContain("Usage: pnpm journal");
  });

  it("lists --md, --format, --limit, --since, --cycle, and --help flags", () => {
    expect(JOURNAL_HELP_TEXT).toContain("--md");
    expect(JOURNAL_HELP_TEXT).toContain("--format");
    expect(JOURNAL_HELP_TEXT).toContain("--limit");
    expect(JOURNAL_HELP_TEXT).toContain("--since");
    expect(JOURNAL_HELP_TEXT).toContain("--cycle");
    expect(JOURNAL_HELP_TEXT).toContain("--help");
  });

  it("ends with a newline (stdout.write-safe)", () => {
    expect(JOURNAL_HELP_TEXT.endsWith("\n")).toBe(true);
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

  it("null optional fields produce identical output to empty-string fields (toBe pin)", () => {
    // Real DB rows from exportJournalJson can have null for missing columns.
    // pushSection uses `if (content)` which is falsy for both "" and null/undefined,
    // so both paths must produce the same output. This pin explicitly documents
    // and locks down the null-handling code path.
    const entries = [
      {
        cycleNumber: 1,
        date: "2026-01-01",
        attempted: null,
        succeeded: null,
        failed: null,
        learnings: null,
        strategic_context: null,
      },
    ] as unknown as Parameters<typeof formatJournalMarkdown>[0];
    const output = formatJournalMarkdown(entries);
    expect(output).toBe(
      "# Bloom Evolution Journal\n\n## Cycle 1 — 2026-01-01\n\n---\n",
    );
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
    const output = formatJournalMarkdown(entries);
    expect(output).toBe(
      "# Bloom Evolution Journal\n\n## Cycle 2 — 2026-02-01\n\n### What was attempted\nAdd a feature\n\n---\n",
    );
    const lines = output.split("\n");
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
    // Exact pin: anchors inter-entry separator placement, blank-line boundaries,
    // doc-header prefix, and section ordering for both entries.
    expect(output).toBe(
      "# Bloom Evolution Journal\n" +
      "\n" +
      "## Cycle 1 — 2025-01-01\n" +
      "\n" +
      "### What was attempted\n" +
      "First attempt\n" +
      "\n" +
      "---\n" +
      "\n" +
      "## Cycle 2 — 2025-01-02\n" +
      "\n" +
      "### What was attempted\n" +
      "Second attempt\n" +
      "\n" +
      "### What succeeded\n" +
      "It worked\n" +
      "\n" +
      "---\n",
    );
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
    expect(output).toBe(
      "# Bloom Evolution Journal\n" +
      "\n" +
      "## Cycle 5 — 2025-01-15\n" +
      "\n" +
      "### What was attempted\n" +
      "Add feature\n" +
      "\n" +
      "### What succeeded\n" +
      "Feature added\n" +
      "\n" +
      "### What failed\n" +
      "Nothing\n" +
      "\n" +
      "### Learnings\n" +
      "Learned something\n" +
      "\n" +
      "### Strategic Context\n" +
      "Focus on testing\n" +
      "\n" +
      "---\n",
    );
    const lines = output.split("\n");
    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe("# Bloom Evolution Journal");
    expect(lines[1]).toBe("");
  });

  it("CRLF line endings in entry fields are normalised before joining (no \\r in output)", () => {
    // GitHub issue bodies can arrive with \r\n. Without normalisation,
    // split("\n") would produce lines with trailing \r, corrupting Markdown
    // rendering and breaking string-equality pins.
    const entries = [
      {
        cycleNumber: 3,
        date: "2026-03-01",
        attempted: "First step\r\nSecond step",
        succeeded: "",
        failed: "",
        learnings: "",
        strategic_context: "",
      },
    ];
    const output = formatJournalMarkdown(entries);
    const lines = output.split("\n");
    // No line should contain a trailing \r after normalisation
    expect(lines.every((l) => !l.includes("\r"))).toBe(true);
    // Structural pins: doc-header and cycle heading are clean
    expect(lines[0]).toBe("# Bloom Evolution Journal");
    expect(lines[2]).toBe("## Cycle 3 — 2026-03-01");
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
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("returns md format when --md is passed", () => {
    const result = parseArgs(["--md"]);
    expect(result).toEqual({ format: "md", limit: undefined, since: undefined, cycle: undefined });
  });

  it("parses --limit with a valid number", () => {
    const result = parseArgs(["--limit", "5"]);
    expect(result).toEqual({ format: "json", limit: 5, since: undefined, cycle: undefined });
  });

  it("handles combined --md and --limit", () => {
    const result = parseArgs(["--md", "--limit", "3"]);
    expect(result).toEqual({ format: "md", limit: 3, since: undefined, cycle: undefined });
  });

  it("ignores --limit with NaN value", () => {
    const result = parseArgs(["--limit", "abc"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("ignores --limit with no following argument", () => {
    const result = parseArgs(["--limit"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("treats --limit 0 as undefined (no limit)", () => {
    const result = parseArgs(["--limit", "0"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("handles negative --limit as undefined", () => {
    const result = parseArgs(["--limit", "-1"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("rejects fractional --limit '3.7' as undefined (non-integer string)", () => {
    // parseIntArg uses /^\d+$/ to reject non-integer strings before parseInt,
    // so "3.7" is treated the same as a non-numeric value → limit is undefined.
    const result = parseArgs(["--limit", "3.7"]);
    expect(result.limit).toBeUndefined();
  });

  it("treats --limit '0.9' as undefined (parseInt → 0, fails > 0 guard)", () => {
    // parseInt("0.9", 10) === 0; 0 > 0 is false, so treated as no limit.
    // Completes the fractional parseInt edge-case matrix alongside the "3.7" case above.
    const result = parseArgs(["--limit", "0.9"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("parses --since with a valid cycle number", () => {
    const result = parseArgs(["--since", "100"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: 100, cycle: undefined });
  });

  it("treats --since 0 as undefined (cycle numbers start at 1)", () => {
    const result = parseArgs(["--since", "0"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("treats negative --since as undefined", () => {
    const result = parseArgs(["--since", "-5"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("ignores --since with NaN value", () => {
    const result = parseArgs(["--since", "abc"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("ignores --since with no following argument", () => {
    const result = parseArgs(["--since"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("handles combined --since and --limit", () => {
    const result = parseArgs(["--since", "50", "--limit", "10"]);
    expect(result).toEqual({ format: "json", limit: 10, since: 50, cycle: undefined });
  });

  it("handles combined --since, --limit, and --md", () => {
    const result = parseArgs(["--md", "--since", "200", "--limit", "5"]);
    expect(result).toEqual({ format: "md", limit: 5, since: 200, cycle: undefined });
  });

  it("parses --cycle with a valid cycle number", () => {
    const result = parseArgs(["--cycle", "731"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: 731 });
  });

  it("treats --cycle 0 as undefined", () => {
    const result = parseArgs(["--cycle", "0"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("treats negative --cycle as undefined", () => {
    const result = parseArgs(["--cycle", "-3"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("ignores --cycle with NaN value", () => {
    const result = parseArgs(["--cycle", "abc"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("ignores --cycle with no following argument", () => {
    const result = parseArgs(["--cycle"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("handles combined --cycle and --md", () => {
    const result = parseArgs(["--md", "--cycle", "42"]);
    expect(result).toEqual({ format: "md", limit: undefined, since: undefined, cycle: 42 });
  });

  it("--format csv returns csv format", () => {
    const result = parseArgs(["--format", "csv"]);
    expect(result).toEqual({ format: "csv", limit: undefined, since: undefined, cycle: undefined });
  });

  it("--format md returns md format (alternative to --md)", () => {
    const result = parseArgs(["--format", "md"]);
    expect(result).toEqual({ format: "md", limit: undefined, since: undefined, cycle: undefined });
  });

  it("--format csv combined with --limit returns csv format and limit", () => {
    const result = parseArgs(["--format", "csv", "--limit", "5"]);
    expect(result).toEqual({ format: "csv", limit: 5, since: undefined, cycle: undefined });
  });

  it("unknown --format value falls back to json", () => {
    const result = parseArgs(["--format", "xml"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("--format without a following argument falls back to json", () => {
    const result = parseArgs(["--format"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("--format csv combined with --since and --limit", () => {
    const result = parseArgs(["--format", "csv", "--since", "700", "--limit", "10"]);
    expect(result).toEqual({ format: "csv", limit: 10, since: 700, cycle: undefined });
  });

  it("--format json explicitly returns json format (falls through csv/md guard)", () => {
    // The format-parsing branch checks `val === "csv" || val === "md"` only.
    // "json" falls through to the default, so format stays "json".
    // This pins the path so a future refactor that adds an explicit "json"
    // branch (or changes the guard to a switch) won't silently break it.
    const result = parseArgs(["--format", "json"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });

  it("--md combined with --format csv: --format wins (json format is default override)", () => {
    // --md is only checked in the else-if branch; when --format is present,
    // --md is ignored entirely. So --format csv beats --md.
    const result = parseArgs(["--md", "--format", "csv"]);
    expect(result).toEqual({ format: "csv", limit: undefined, since: undefined, cycle: undefined });
  });
});

describe("generateJournalOutput --search filter", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertCycle(db, makeOutcome({ cycleNumber: 3 }));
    insertJournalEntry(db, 1, "attempted", "Refactor the parser module");
    insertJournalEntry(db, 1, "succeeded", "Parser fully refactored");
    insertJournalEntry(db, 2, "attempted", "Add CSV export feature");
    insertJournalEntry(db, 2, "learnings", "CSV quoting is tricky");
    insertJournalEntry(db, 3, "attempted", "Improve test coverage");
    insertJournalEntry(db, 3, "strategic_context", "Focus on refactoring and coverage");
  });

  it("returns all entries when search is empty string", () => {
    const output = generateJournalOutput(db, { search: "" });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(3);
  });

  it("returns only matching entries for a term in attempted field", () => {
    const output = generateJournalOutput(db, { search: "parser" });
    const parsed = JSON.parse(output) as Array<{ cycleNumber: number }>;
    expect(parsed.map((e) => e.cycleNumber).sort((a, b) => a - b)).toEqual([1]);
  });

  it("matches case-insensitively", () => {
    const output = generateJournalOutput(db, { search: "CSV" });
    const parsed = JSON.parse(output) as Array<{ cycleNumber: number }>;
    expect(parsed.map((e) => e.cycleNumber).sort((a, b) => a - b)).toEqual([2]);
  });

  it("matches term found in learnings field", () => {
    const output = generateJournalOutput(db, { search: "quoting" });
    const parsed = JSON.parse(output) as Array<{ cycleNumber: number }>;
    expect(parsed.map((e) => e.cycleNumber)).toEqual(expect.arrayContaining([2]));
    expect(parsed).toHaveLength(1);
  });

  it("matches term found in strategic_context field", () => {
    const output = generateJournalOutput(db, { search: "refactoring" });
    const parsed = JSON.parse(output) as Array<{ cycleNumber: number }>;
    // cycle 3 has 'refactoring' in strategic_context
    // cycle 1 has 'Refactor' in attempted but NOT 'refactoring' (no suffix)
    expect(parsed.map((e) => e.cycleNumber)).toEqual([3]);
  });

  it("returns empty array when no entries match the search term", () => {
    const output = generateJournalOutput(db, { search: "nonexistentxyzzy" });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(0);
  });

  it("search works with --format md (only matching entries rendered)", () => {
    const output = generateJournalOutput(db, { format: "md", search: "csv" });
    expect(output).toContain("## Cycle 2");
    expect(output).not.toContain("## Cycle 1");
    expect(output).not.toContain("## Cycle 3");
  });

  it("search combines with --limit (limit applied before search filter)", () => {
    // Cycles 1-3 exist; limit 2 returns cycles 3 and 2 (most recent); then
    // search 'parser' should match none of those two (cycle 1 is excluded by limit).
    const output = generateJournalOutput(db, { search: "parser", limit: 2 });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(0);
  });

  it("whitespace-only search is ignored (returns all entries)", () => {
    const output = generateJournalOutput(db, { search: "   " });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(3);
  });

  it("search with --format csv and zero matches still emits header row", () => {
    // When no entries match, generateJournalCsv([]) should produce header-only
    // output — not an empty string. This pins the contract that the CSV header
    // is always present regardless of the search result.
    const output = generateJournalOutput(db, { format: "csv", search: "nonexistentxyzzy" });
    expect(output).toBe("cycleNumber,date,attempted,succeeded,failed,learnings,strategic_context\n");
  });

  it("search with --format csv and matching entries includes those entries", () => {
    const output = generateJournalOutput(db, { format: "csv", search: "csv" });
    // Header row always present
    expect(output).toContain("cycleNumber,date,attempted,succeeded,failed,learnings,strategic_context");
    // Cycle 2 has "CSV" in its fields
    expect(output).toContain("Add CSV export feature");
    // Cycle 1 (parser) and cycle 3 (coverage) should not appear
    expect(output).not.toContain("Refactor the parser module");
    expect(output).not.toContain("Improve test coverage");
  });
});

describe("parseArgs --verbose", () => {
  it("returns verbose: true when --verbose flag is present", () => {
    const result = parseArgs(["--verbose"]);
    expect(result.verbose).toBe(true);
  });

  it("returns verbose: undefined when --verbose flag is absent", () => {
    const result = parseArgs([]);
    expect(result.verbose).toBeUndefined();
  });

  it("combines --verbose with --format md", () => {
    const result = parseArgs(["--verbose", "--format", "md"]);
    expect(result.verbose).toBe(true);
    expect(result.format).toBe("md");
  });

  it("combines --verbose with --limit", () => {
    const result = parseArgs(["--verbose", "--limit", "5"]);
    expect(result.verbose).toBe(true);
    expect(result.limit).toBe(5);
  });

  it("JOURNAL_HELP_TEXT lists --verbose flag", () => {
    expect(JOURNAL_HELP_TEXT).toContain("--verbose");
  });
});

describe("generateJournalOutput --verbose (JSON mode)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("JSON verbose with entries returns object with totalEntries and cycleRange", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 10 }));
    insertCycle(db, makeOutcome({ cycleNumber: 20 }));
    insertJournalEntry(db, 10, "attempted", "First");
    insertJournalEntry(db, 20, "attempted", "Second");

    const output = generateJournalOutput(db, { verbose: true });
    const parsed = JSON.parse(output);
    expect(parsed.totalEntries).toBe(2);
    expect(parsed.cycleRange).toEqual({ min: 10, max: 20 });
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries).toHaveLength(2);
  });

  it("JSON verbose with no entries returns totalEntries: 0 and cycleRange: null", () => {
    const output = generateJournalOutput(db, { verbose: true });
    const parsed = JSON.parse(output);
    expect(parsed.totalEntries).toBe(0);
    expect(parsed.cycleRange).toBeNull();
    expect(parsed.entries).toEqual([]);
  });

  it("JSON verbose single entry has cycleRange min === max", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 42 }));
    insertJournalEntry(db, 42, "attempted", "Solo");

    const output = generateJournalOutput(db, { verbose: true });
    const parsed = JSON.parse(output);
    expect(parsed.totalEntries).toBe(1);
    expect(parsed.cycleRange).toEqual({ min: 42, max: 42 });
  });

  it("JSON without verbose returns plain array (no metadata wrapper)", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertJournalEntry(db, 1, "attempted", "Something");

    const output = generateJournalOutput(db);
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.totalEntries).toBeUndefined();
  });
});

describe("generateJournalOutput --verbose (md mode)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("md verbose with entries contains summary line with entry count and range", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 5 }));
    insertCycle(db, makeOutcome({ cycleNumber: 15 }));
    insertJournalEntry(db, 5, "attempted", "First");
    insertJournalEntry(db, 15, "attempted", "Second");

    const output = generateJournalOutput(db, { format: "md", verbose: true });
    expect(output).toContain("Entries: 2 | Range: 5–15");
    expect(output).toContain("# Bloom Evolution Journal");
  });

  it("md verbose summary line appears after the top-level heading", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 7 }));
    insertJournalEntry(db, 7, "attempted", "Work");

    const output = generateJournalOutput(db, { format: "md", verbose: true });
    const lines = output.split("\n");
    // Line 0: "# Bloom Evolution Journal", line 1: "Entries: ..."
    expect(lines[0]).toBe("# Bloom Evolution Journal");
    expect(lines[1]).toContain("Entries: 1 | Range: 7–7");
  });

  it("md verbose with no entries does not inject summary line", () => {
    const output = generateJournalOutput(db, { format: "md", verbose: true });
    expect(output).toBe("No journal entries recorded yet.");
    expect(output).not.toContain("Entries:");
  });

  it("md without verbose does not inject summary line", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 3 }));
    insertJournalEntry(db, 3, "attempted", "Work");

    const output = generateJournalOutput(db, { format: "md" });
    expect(output).not.toContain("Entries:");
    expect(output).toContain("# Bloom Evolution Journal");
  });
});

describe("parseArgs --search", () => {
  it("parses --search with a term", () => {
    const result = parseArgs(["--search", "keyword"]);
    expect(result.search).toBe("keyword");
  });

  it("search is undefined when flag is absent", () => {
    const result = parseArgs([]);
    expect(result.search).toBeUndefined();
  });

  it("search is undefined when --search has no following argument", () => {
    const result = parseArgs(["--search"]);
    expect(result.search).toBeUndefined();
  });

  it("search is undefined when --search is followed by another flag", () => {
    const result = parseArgs(["--search", "--limit"]);
    expect(result.search).toBeUndefined();
  });

  it("combines --search with --format csv", () => {
    const result = parseArgs(["--format", "csv", "--search", "refactor"]);
    expect(result.format).toBe("csv");
    expect(result.search).toBe("refactor");
  });

  it("JOURNAL_HELP_TEXT lists --search flag", () => {
    expect(JOURNAL_HELP_TEXT).toContain("--search");
  });
});

describe("generateJournalCsv", () => {
  it("empty array returns header-only line", () => {
    const output = generateJournalCsv([]);
    expect(output).toBe("cycleNumber,date,attempted,succeeded,failed,learnings,strategic_context\n");
  });

  it("single entry is correctly serialised (no special chars)", () => {
    const entries: JournalExportEntry[] = [{
      cycleNumber: 1,
      date: "2025-01-01",
      attempted: "Add feature",
      succeeded: "Feature added",
      failed: "None",
      learnings: "Learned",
      strategic_context: "Stay focused",
    }];
    const lines = generateJournalCsv(entries).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("cycleNumber,date,attempted,succeeded,failed,learnings,strategic_context");
    expect(lines[1]).toBe("1,2025-01-01,Add feature,Feature added,None,Learned,Stay focused");
  });

  it("multiple entries produce one row per entry plus header", () => {
    const entries: JournalExportEntry[] = [
      { cycleNumber: 1, date: "2025-01-01", attempted: "A", succeeded: "B", failed: "C", learnings: "D", strategic_context: "E" },
      { cycleNumber: 2, date: "2025-01-02", attempted: "F", succeeded: "G", failed: "H", learnings: "I", strategic_context: "J" },
    ];
    const lines = generateJournalCsv(entries).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("2,2025-01-02,F,G,H,I,J");
  });

  it("fields with commas are RFC 4180 quoted", () => {
    const entries: JournalExportEntry[] = [{
      cycleNumber: 1,
      date: "2025-01-01",
      attempted: "Fix bug, add test",
      succeeded: "",
      failed: "",
      learnings: "",
      strategic_context: "",
    }];
    const output = generateJournalCsv(entries);
    expect(output).toContain('"Fix bug, add test"');
  });

  it("fields with double-quotes are RFC 4180 escaped (doubled)", () => {
    const entries: JournalExportEntry[] = [{
      cycleNumber: 1,
      date: "2025-01-01",
      attempted: 'He said "hello"',
      succeeded: "",
      failed: "",
      learnings: "",
      strategic_context: "",
    }];
    const output = generateJournalCsv(entries);
    expect(output).toContain('"He said ""hello"""');
  });

  it("fields with newlines are RFC 4180 quoted", () => {
    const entries: JournalExportEntry[] = [{
      cycleNumber: 1,
      date: "2025-01-01",
      attempted: "First step\nSecond step",
      succeeded: "",
      failed: "",
      learnings: "",
      strategic_context: "",
    }];
    const output = generateJournalCsv(entries);
    expect(output).toContain('"First step\nSecond step"');
  });

  it("null fields are treated as empty string", () => {
    const entries = [{
      cycleNumber: 1,
      date: "2025-01-01",
      attempted: null,
      succeeded: null,
      failed: null,
      learnings: null,
      strategic_context: null,
    }] as unknown as JournalExportEntry[];
    const lines = generateJournalCsv(entries).trimEnd().split("\n");
    expect(lines[1]).toBe("1,2025-01-01,,,,,");
  });

  it("output always ends with a trailing newline", () => {
    expect(generateJournalCsv([])).toMatch(/\n$/);
    const entries: JournalExportEntry[] = [
      { cycleNumber: 1, date: "2025-01-01", attempted: "x", succeeded: "", failed: "", learnings: "", strategic_context: "" },
    ];
    expect(generateJournalCsv(entries)).toMatch(/\n$/);
  });

});

describe("generateJournalTable", () => {
  it("returns empty string for empty entries array", () => {
    expect(generateJournalTable([])).toBe("");
  });

  it("returns header, separator, and one data row for a single entry", () => {
    const entries: JournalExportEntry[] = [{
      cycleNumber: 42,
      date: "2025-06-01",
      attempted: "Fix a bug",
      succeeded: "Bug fixed",
      failed: "nothing",
      learnings: "",
      strategic_context: "",
    }];
    const output = generateJournalTable(entries);
    const lines = output.split("\n");
    expect(lines).toHaveLength(3); // header + separator + 1 data row
    expect(lines[0]).toContain("Cycle");
    expect(lines[0]).toContain("Date");
    expect(lines[0]).toContain("Attempted");
    expect(lines[0]).toContain("Succeeded");
    expect(lines[0]).toContain("Failed");
    expect(lines[1]).toMatch(/^-+/);
    expect(lines[2]).toContain("42");
    expect(lines[2]).toContain("2025-06-01");
    expect(lines[2]).toContain("Fix a bug");
    expect(lines[2]).toContain("Bug fixed");
    expect(lines[2]).toContain("nothing");
  });

  it("returns header + separator + N rows for N entries", () => {
    const entries: JournalExportEntry[] = [
      { cycleNumber: 1, date: "2025-01-01", attempted: "Attempt A", succeeded: "Succeed A", failed: "Fail A", learnings: "", strategic_context: "" },
      { cycleNumber: 2, date: "2025-01-02", attempted: "Attempt B", succeeded: "Succeed B", failed: "Fail B", learnings: "", strategic_context: "" },
      { cycleNumber: 3, date: "2025-01-03", attempted: "Attempt C", succeeded: "Succeed C", failed: "Fail C", learnings: "", strategic_context: "" },
    ];
    const output = generateJournalTable(entries);
    const lines = output.split("\n");
    expect(lines).toHaveLength(5); // header + separator + 3 data rows
    expect(lines[2]).toContain("1");
    expect(lines[3]).toContain("2");
    expect(lines[4]).toContain("3");
  });

  it("truncates long text fields with an ellipsis", () => {
    const longText = "A".repeat(50);
    const entries: JournalExportEntry[] = [{
      cycleNumber: 1,
      date: "2025-01-01",
      attempted: longText,
      succeeded: "",
      failed: "",
      learnings: "",
      strategic_context: "",
    }];
    const output = generateJournalTable(entries);
    const dataRow = output.split("\n")[2];
    // The Attempted column is 40 chars wide; 50-char text should be truncated
    expect(dataRow).toContain("\u2026"); // ellipsis character
    expect(dataRow).not.toContain(longText);
  });

  it("only shows first line of multi-line text fields", () => {
    const entries: JournalExportEntry[] = [{
      cycleNumber: 1,
      date: "2025-01-01",
      attempted: "First line\nSecond line",
      succeeded: "",
      failed: "",
      learnings: "",
      strategic_context: "",
    }];
    const output = generateJournalTable(entries);
    expect(output).toContain("First line");
    expect(output).not.toContain("Second line");
  });

  it("handles null/undefined text fields gracefully", () => {
    const entries = [{
      cycleNumber: 1,
      date: "2025-01-01",
      attempted: null,
      succeeded: null,
      failed: null,
      learnings: null,
      strategic_context: null,
    }] as unknown as JournalExportEntry[];
    expect(() => generateJournalTable(entries)).not.toThrow();
    const output = generateJournalTable(entries);
    expect(output.split("\n")).toHaveLength(3);
  });
});

describe("parseArgs --format table", () => {
  it("--format table returns table format", () => {
    const result = parseArgs(["--format", "table"]);
    expect(result).toEqual({ format: "table", limit: undefined, since: undefined, cycle: undefined });
  });

  it("--format bogus falls back to json (unknown format fallback)", () => {
    const result = parseArgs(["--format", "bogus"]);
    expect(result).toEqual({ format: "json", limit: undefined, since: undefined, cycle: undefined });
  });
});

describe("generateJournalOutput --format table", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("returns 'No journal entries recorded yet.' for empty DB", () => {
    const output = generateJournalOutput(db, { format: "table" });
    expect(output).toBe("No journal entries recorded yet.");
  });

  it("returns ASCII table with header and data rows for existing entries", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 800 }));
    insertJournalEntry(db, 800, "attempted", "Add table format");
    insertJournalEntry(db, 800, "succeeded", "Table implemented");

    const output = generateJournalOutput(db, { format: "table" });
    expect(output).toContain("Cycle");
    expect(output).toContain("800");
    expect(output).toContain("Add table format");
    expect(output).toContain("Table implemented");
  });

  it("table verbose appends footer with entry count and cycle range", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 10 }));
    insertCycle(db, makeOutcome({ cycleNumber: 20 }));
    insertJournalEntry(db, 10, "attempted", "First attempt");
    insertJournalEntry(db, 20, "attempted", "Second attempt");

    const output = generateJournalOutput(db, { format: "table", verbose: true });
    expect(output).toContain("Entries: 2 | Range: 10\u201320");
  });

  it("table verbose with empty DB still returns sentinel string", () => {
    const output = generateJournalOutput(db, { format: "table", verbose: true });
    expect(output).toBe("No journal entries recorded yet.");
  });

  it("table without verbose does not append footer", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 5 }));
    insertJournalEntry(db, 5, "attempted", "Some attempt");

    const output = generateJournalOutput(db, { format: "table" });
    expect(output).not.toContain("Entries:");
  });
});

describe("JOURNAL_CSV_HEADER", () => {
  it("is pinned to the expected column names", () => {
    expect(JOURNAL_CSV_HEADER).toBe(
      "cycleNumber,date,attempted,succeeded,failed,learnings,strategic_context"
    );
  });

  it("generateJournalCsv uses JOURNAL_CSV_HEADER as the first row", () => {
    const csv = generateJournalCsv([]);
    expect(csv.split("\n")[0]).toBe(JOURNAL_CSV_HEADER);
  });

  it("header-only output for empty entries is exactly JOURNAL_CSV_HEADER + newline", () => {
    const csv = generateJournalCsv([]);
    expect(csv).toBe(JOURNAL_CSV_HEADER + "\n");
  });
});
