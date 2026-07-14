/**
 * Integration test for the --output-file write behaviour in stats.ts.
 *
 * writeFileSync(outputFile, outputContent) inside main() is not exercised by
 * unit tests — they import stats.ts directly and never invoke main().  This
 * file uses spawnSync so the real CLI code path is executed, including the
 * file-write side-effect that unit tests cannot observe.
 *
 * Setup: each test creates a temporary directory, optionally seeds a
 * bloom.db, then runs `tsx src/stats.ts --output-file <tmppath>` from that
 * directory (stats.ts reads `bloom.db` relative to CWD).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, insertCycle, insertPhaseUsage } from "../src/db.js";
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
  const dir = mkdtempSync(join(tmpdir(), "bloom-output-file-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Seed a bloom.db in `dir` with one cycle. */
function seedDb(dir: string): void {
  const dbPath = join(dir, "bloom.db");
  const db = initDb(dbPath);
  insertCycle(db, makeOutcome({ cycleNumber: 1 }));
  insertPhaseUsage(db, 1, {
    phase: "evolve",
    totalCostUsd: 0.10,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    durationMs: 5000,
    numTurns: 3,
  });
  db.close();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("--output-file integration", () => {
  it("exits with code 0 when --output-file is provided", () => {
    const dir = makeTempDir();
    seedDb(dir);
    const outPath = join(dir, "stats-out.txt");

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--output-file", outPath], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
  });

  it("creates the output file when --output-file is provided", () => {
    const dir = makeTempDir();
    seedDb(dir);
    const outPath = join(dir, "stats-out.txt");

    spawnSync(TSX_BIN, [STATS_SCRIPT, "--output-file", outPath], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(existsSync(outPath)).toBe(true);
  });

  it("file content matches stdout", () => {
    const dir = makeTempDir();
    seedDb(dir);
    const outPath = join(dir, "stats-out.txt");

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--output-file", outPath], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    const fileContent = readFileSync(outPath, "utf8");
    expect(fileContent).toBe(result.stdout);
  });

  it("file content matches stdout in --csv mode", () => {
    const dir = makeTempDir();
    seedDb(dir);
    const outPath = join(dir, "stats-out.csv");

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--csv", "--output-file", outPath], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
    const fileContent = readFileSync(outPath, "utf8");
    expect(fileContent).toBe(result.stdout);
  });

  it("file content matches stdout in --json mode", () => {
    const dir = makeTempDir();
    seedDb(dir);
    const outPath = join(dir, "stats-out.json");

    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--json", "--output-file", outPath], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
    const fileContent = readFileSync(outPath, "utf8");
    expect(fileContent).toBe(result.stdout);
  });
});
