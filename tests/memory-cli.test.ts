import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initDb, insertCycle, insertLearning, insertStrategicContext } from "../src/db.js";
import { generateMemoryOutput, MEMORY_HELP_TEXT } from "../scripts/memory.js";
import { parseHelpFlag, parseVerboseFlag, parseSearchArg } from "../src/stats.js";
import { makeOutcome } from "./helpers.js";

// ---------------------------------------------------------------------------
// MEMORY_HELP_TEXT content invariants
// ---------------------------------------------------------------------------

describe("MEMORY_HELP_TEXT", () => {
  it("mentions pnpm memory usage", () => {
    expect(MEMORY_HELP_TEXT).toContain("pnpm memory");
  });

  it("documents --verbose flag", () => {
    expect(MEMORY_HELP_TEXT).toContain("--verbose");
  });

  it("documents --search flag", () => {
    expect(MEMORY_HELP_TEXT).toContain("--search");
  });

  it("documents --help flag", () => {
    expect(MEMORY_HELP_TEXT).toContain("--help");
  });

  it("documents -h shorthand", () => {
    expect(MEMORY_HELP_TEXT).toContain("-h");
  });
});

// ---------------------------------------------------------------------------
// parseHelpFlag / parseVerboseFlag reuse (verifies CLI shares stat helpers)
// ---------------------------------------------------------------------------

describe("flag parsing reuse", () => {
  it("parseHelpFlag detects --help in memory argv", () => {
    expect(parseHelpFlag(["node", "memory.ts", "--help"])).toBe(true);
  });

  it("parseHelpFlag detects -h shorthand", () => {
    expect(parseHelpFlag(["node", "memory.ts", "-h"])).toBe(true);
  });

  it("parseHelpFlag returns false when flag absent", () => {
    expect(parseHelpFlag(["node", "memory.ts"])).toBe(false);
  });

  it("parseVerboseFlag detects --verbose", () => {
    expect(parseVerboseFlag(["node", "memory.ts", "--verbose"])).toBe(true);
  });

  it("parseVerboseFlag returns false when flag absent", () => {
    expect(parseVerboseFlag(["node", "memory.ts"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateMemoryOutput — empty database
// ---------------------------------------------------------------------------

describe("generateMemoryOutput — empty database", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("default mode returns 'No memory stored yet.'", () => {
    const output = generateMemoryOutput(db);
    expect(output.join("\n")).toContain("No memory stored yet.");
  });

  it("verbose mode returns 'No learnings stored yet.'", () => {
    const output = generateMemoryOutput(db, true);
    expect(output.join("\n")).toContain("No learnings stored yet.");
  });

  it("default mode returns an array of strings", () => {
    const output = generateMemoryOutput(db);
    expect(Array.isArray(output)).toBe(true);
    expect(output.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// generateMemoryOutput — database with strategic context and learnings
// ---------------------------------------------------------------------------

describe("generateMemoryOutput — with data", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    // Insert cycles first to satisfy foreign key constraints on learnings/strategic_context
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertStrategicContext(db, 1, "Focus on safety improvements.");
    insertLearning(db, 1, "pattern", "Incremental changes reduce risk.");
    insertLearning(db, 1, "anti-pattern", "Inline code execution is blocked by hooks.");
    insertLearning(db, 2, "domain", "SQLite WAL mode allows concurrent reads.");
  });

  describe("default mode", () => {
    it("includes strategic context", () => {
      const joined = generateMemoryOutput(db).join("\n");
      expect(joined).toContain("Strategic Context");
      expect(joined).toContain("Focus on safety improvements.");
    });

    it("includes at least one learning", () => {
      const joined = generateMemoryOutput(db).join("\n");
      expect(joined).toContain("Incremental changes reduce risk.");
    });
  });

  describe("verbose mode", () => {
    it("shows strategic context header and content", () => {
      const joined = generateMemoryOutput(db, true).join("\n");
      expect(joined).toContain("## Strategic Context");
      expect(joined).toContain("Focus on safety improvements.");
    });

    it("shows Learnings by Category header", () => {
      const joined = generateMemoryOutput(db, true).join("\n");
      expect(joined).toContain("## Learnings by Category");
    });

    it("shows category sub-headers for populated categories", () => {
      const joined = generateMemoryOutput(db, true).join("\n");
      expect(joined).toContain("### pattern");
      expect(joined).toContain("### anti-pattern");
      expect(joined).toContain("### domain");
    });

    it("includes relevance scores in [N.NNN] format", () => {
      const joined = generateMemoryOutput(db, true).join("\n");
      expect(joined).toMatch(/\[\d+\.\d{3}\]/);
    });

    it("includes learning content in verbose output", () => {
      const joined = generateMemoryOutput(db, true).join("\n");
      expect(joined).toContain("Incremental changes reduce risk.");
      expect(joined).toContain("Inline code execution is blocked by hooks.");
      expect(joined).toContain("SQLite WAL mode allows concurrent reads.");
    });

    it("does not output 'No learnings stored yet.' when learnings exist", () => {
      const joined = generateMemoryOutput(db, true).join("\n");
      expect(joined).not.toContain("No learnings stored yet.");
    });
  });
});

// ---------------------------------------------------------------------------
// parseSearchArg reuse in memory CLI
// ---------------------------------------------------------------------------

describe("parseSearchArg reuse in memory CLI", () => {
  it("returns the search term when --search is present", () => {
    expect(parseSearchArg(["node", "memory.ts", "--search", "incremental"])).toBe("incremental");
  });

  it("returns undefined when --search flag is absent", () => {
    expect(parseSearchArg(["node", "memory.ts", "--verbose"])).toBeUndefined();
  });

  it("returns undefined when --search has no value", () => {
    expect(parseSearchArg(["node", "memory.ts", "--search"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateMemoryOutput — --search filtering
// ---------------------------------------------------------------------------

describe("generateMemoryOutput — search filtering", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertStrategicContext(db, 1, "Focus on safety improvements.");
    insertLearning(db, 1, "pattern", "Incremental changes reduce risk.");
    insertLearning(db, 1, "anti-pattern", "Inline code execution is blocked by hooks.");
    insertLearning(db, 2, "domain", "SQLite WAL mode allows concurrent reads.");
  });

  it("returns matching learnings when search term matches", () => {
    const joined = generateMemoryOutput(db, false, "incremental").join("\n");
    expect(joined).toContain("Incremental changes reduce risk.");
  });

  it("excludes non-matching learnings", () => {
    const joined = generateMemoryOutput(db, false, "incremental").join("\n");
    expect(joined).not.toContain("SQLite WAL mode allows concurrent reads.");
  });

  it("is case-insensitive", () => {
    const joined = generateMemoryOutput(db, false, "SQLITE").join("\n");
    expect(joined).toContain("SQLite WAL mode allows concurrent reads.");
  });

  it("shows header with the search term", () => {
    const joined = generateMemoryOutput(db, false, "incremental").join("\n");
    expect(joined).toContain('Learnings matching "incremental"');
  });

  it("returns no-match message when term is not found", () => {
    const joined = generateMemoryOutput(db, false, "xyznotfound").join("\n");
    expect(joined).toContain('No learnings matching "xyznotfound".');
  });

  it("returns no-match message on empty database", () => {
    const emptyDb = initDb(":memory:");
    const joined = generateMemoryOutput(emptyDb, false, "anything").join("\n");
    expect(joined).toContain('No learnings matching "anything".');
  });

  it("does not include strategic context when filtering by search term", () => {
    const joined = generateMemoryOutput(db, false, "incremental").join("\n");
    expect(joined).not.toContain("Focus on safety improvements.");
  });
});
