/**
 * Integration test for the --trend N output mode in stats.ts.
 *
 * The `if (trendN !== undefined)` branch in main() calls generateStatsTrend()
 * and writes its output to stdout — this code path is unreachable through unit
 * imports because calling main() directly would require process.argv manipulation
 * and would not exercise the full CLI lifecycle.  spawnSync lets us assert the
 * exit code and stdout without affecting the test process.
 *
 * Setup: each test creates a temporary directory and optionally seeds a
 * bloom.db, then runs `tsx src/stats.ts --trend N` from that directory
 * (stats.ts reads `bloom.db` relative to CWD).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, insertCycle } from "../src/db.js";
import { STATS_TREND_PREFIX } from "../src/stats.js";
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
  const dir = mkdtempSync(join(tmpdir(), "bloom-trend-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Seed a bloom.db in `dir` with `count` passed cycles. */
function seedDb(dir: string, count = 3): void {
  const dbPath = join(dir, "bloom.db");
  const db = initDb(dbPath);
  for (let i = 1; i <= count; i++) {
    insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: true, pushSucceeded: true }));
  }
  db.close();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("stats --trend integration", () => {
  it("exits with code 0 when DB has cycles", () => {
    const dir = makeTempDir();
    seedDb(dir);

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--trend", "10"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
  });

  it("stdout contains STATS_TREND_PREFIX when DB has cycles", () => {
    const dir = makeTempDir();
    seedDb(dir);

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--trend", "10"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stdout).toContain(STATS_TREND_PREFIX);
  });

  it("stdout contains the cycle count in the trend line", () => {
    const dir = makeTempDir();
    seedDb(dir, 3);

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--trend", "10"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    // 3 cycles seeded; trend line should show "Trend (last 3):"
    expect(result.stdout).toContain(`${STATS_TREND_PREFIX}3):`);
  });

  it("exits with code 0 and prints empty-db message when DB has no cycles", () => {
    const dir = makeTempDir();
    // No DB seeded — stats.ts will open an empty DB via initDb()

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--trend", "5"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No evolution cycles recorded yet.");
  });

  it("emits no stderr for --trend with a seeded DB", () => {
    const dir = makeTempDir();
    seedDb(dir);

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--trend", "10"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stderr ?? "").toBe("");
  });
});
