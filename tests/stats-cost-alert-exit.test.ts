/**
 * Integration test for the --cost-alert exit behavior in stats.ts.
 *
 * The process.exit(1) path in main() cannot be covered by unit tests that
 * import stats.ts directly — calling process.exit in the same process would
 * abort the test runner. This file uses spawnSync to spawn a real subprocess
 * so the exit code can be asserted without affecting the test process.
 *
 * Setup: each test creates a temporary directory, writes a bloom.db with
 * cycle+phase_usage data, then runs `tsx src/stats.ts --cost-alert <N>`
 * from that directory (stats.ts reads `bloom.db` relative to CWD).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, insertCycle, insertPhaseUsage } from "../src/db.js";
import { makeOutcome } from "./helpers.js";

/** Absolute path to the repo root (two levels up from tests/). */
const REPO_ROOT = join(import.meta.dirname, "..");

/** Absolute path to the tsx binary bundled in node_modules. */
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** Absolute path to the stats CLI entry point. */
const STATS_SCRIPT = join(REPO_ROOT, "src", "stats.ts");

/** A PhaseUsage fixture with a fixed cost so avgCostPerCycle is predictable. */
const PHASE_USAGE_1_USD = {
  phase: "evolve",
  totalCostUsd: 1.00,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  durationMs: 5000,
  numTurns: 3,
};

/** Temp directories created during tests; cleaned up in afterEach. */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bloom-cost-alert-test-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Create a temporary bloom.db in `dir` with one cycle and phase usage worth
 * `costUsd` total. Returns the path to the created database file.
 */
function seedDb(dir: string, costUsd: number): string {
  const dbPath = join(dir, "bloom.db");
  const db = initDb(dbPath);
  insertCycle(db, makeOutcome({ cycleNumber: 1 }));
  insertPhaseUsage(db, 1, { ...PHASE_USAGE_1_USD, totalCostUsd: costUsd });
  db.close();
  return dbPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("--cost-alert exit integration", () => {
  it("exits with code 1 when avgCostPerCycle exceeds threshold", () => {
    const dir = makeTempDir();
    seedDb(dir, 1.00); // avgCostPerCycle = $1.00

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--cost-alert", "0.50"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(1);
    const combined = (result.stderr ?? "") + (result.stdout ?? "");
    expect(combined).toContain("COST ALERT");
    expect(combined).toContain("0.50");
  });

  it("exits with code 0 when avgCostPerCycle is below threshold", () => {
    const dir = makeTempDir();
    seedDb(dir, 0.25); // avgCostPerCycle = $0.25

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--cost-alert", "0.50"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
    const combined = (result.stderr ?? "") + (result.stdout ?? "");
    expect(combined).not.toContain("COST ALERT");
  });

  it("exits with code 0 when avgCostPerCycle equals threshold (not strictly greater)", () => {
    const dir = makeTempDir();
    seedDb(dir, 0.50); // avgCostPerCycle = $0.50, threshold = $0.50

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--cost-alert", "0.50"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    // checkCostAlert uses strict `>` so equal-to-threshold is NOT an alert
    expect(result.status).toBe(0);
  });

  it("exits with code 0 when --cost-alert flag is absent (no threshold check)", () => {
    const dir = makeTempDir();
    seedDb(dir, 5.00); // high cost but no threshold flag

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
  });
});
