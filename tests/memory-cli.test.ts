import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initDb, insertCycle, insertLearning, insertStrategicContext } from "../src/db.js";
import { generateMemoryOutput, MEMORY_HELP_TEXT } from "../scripts/memory.js";
import { parseHelpFlag, parseVerboseFlag } from "../src/stats.js";
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
