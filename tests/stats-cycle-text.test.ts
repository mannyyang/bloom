/**
 * Integration test for `pnpm stats --cycle N` in text (default) mode.
 *
 * Verifies that the --cycle N flag is respected by generateStatsOutput:
 *   (a) the window label includes "cycle: N"
 *   (b) Latest cycle still reflects the DB-wide latest, not the pinned cycle
 *   (c) the process exits with code 0
 *
 * Uses spawnSync so the real main() code path is exercised, matching the
 * pattern established in stats-output-file.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, insertCycle } from "../src/db.js";
import { makeOutcome } from "./helpers.js";

/** Absolute path to the repo root (one level up from tests/). */
const REPO_ROOT = join(import.meta.dirname, "..");

/** Absolute path to the tsx binary bundled in node_modules. */
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** Absolute path to the stats CLI entry point. */
const STATS_SCRIPT = join(REPO_ROOT, "src", "stats.ts");

/** Temp directories created during tests; cleaned up in afterEach. */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bloom-cycle-text-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Seed a bloom.db in `dir` with two cycles (1 and 2). */
function seedDb(dir: string): void {
  const dbPath = join(dir, "bloom.db");
  const db = initDb(dbPath);
  insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: true, pushSucceeded: true }));
  insertCycle(db, makeOutcome({ cycleNumber: 2, buildVerificationPassed: false, pushSucceeded: false }));
  db.close();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("--cycle N text-mode integration", () => {
  it("exits with code 0 when --cycle N is provided", () => {
    const dir = makeTempDir();
    seedDb(dir);

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--cycle", "1"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
  });

  it("window label contains 'cycle: N' when --cycle N is provided", () => {
    const dir = makeTempDir();
    seedDb(dir);

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--cycle", "1"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stdout).toContain("cycle: 1");
  });

  it("Latest cycle reflects the DB-wide latest, not the pinned cycle", () => {
    const dir = makeTempDir();
    seedDb(dir);

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--cycle", "1"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    // The DB-wide latest is cycle 2; the header must reflect that
    expect(result.stdout).toContain("Latest cycle: 2");
  });

  it("no extra 'since cycle' or 'last N cycles' label when --cycle N is used alone", () => {
    const dir = makeTempDir();
    seedDb(dir);

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--cycle", "1"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stdout).not.toContain("since cycle");
    expect(result.stdout).not.toContain("last N cycles");
    // The window label should not include a "last N cycles" or "since cycle N" clause
    expect(result.stdout).not.toMatch(/\(last \d+ cycles\)/);
  });
});
