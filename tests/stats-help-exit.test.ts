/**
 * Integration test for --help / -h exit behaviour in stats.ts and journal.ts.
 *
 * process.exit(0) inside main() cannot be covered by unit tests that import
 * the module directly — calling process.exit in the same process would abort
 * the test runner.  spawnSync lets us assert the exit code and stdout without
 * affecting the test process.
 *
 * No bloom.db is required; --help must work before the DB is opened.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Absolute path to the repo root (one level up from tests/). */
const REPO_ROOT = join(import.meta.dirname, "..");

/** Absolute path to the tsx binary bundled in node_modules. */
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** Absolute path to the stats CLI entry point. */
const STATS_SCRIPT = join(REPO_ROOT, "src", "stats.ts");

/** Absolute path to the journal CLI entry point. */
const JOURNAL_SCRIPT = join(REPO_ROOT, "src", "journal.ts");

/** Temp directories created during tests; cleaned up in afterEach. */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bloom-help-exit-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("stats --help exit integration", () => {
  it("exits with code 0 for --help", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
  });

  it("prints usage text to stdout for --help", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stdout).toContain("Usage: pnpm stats");
  });

  it("emits no stderr for --help", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stderr ?? "").toBe("");
  });

  it("exits with code 0 for -h alias", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [STATS_SCRIPT, "-h"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: pnpm stats");
  });
});

describe("journal --help exit integration", () => {
  it("exits with code 0 for --help", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [JOURNAL_SCRIPT, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
  });

  it("prints usage text to stdout for --help", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [JOURNAL_SCRIPT, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stdout).toContain("Usage: pnpm journal");
  });

  it("emits no stderr for --help", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [JOURNAL_SCRIPT, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stderr ?? "").toBe("");
  });
});
