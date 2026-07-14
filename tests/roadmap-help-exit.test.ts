/**
 * Integration test for --help / -h exit behaviour in roadmap.ts.
 *
 * process.exit(0) inside roadmap main() cannot be covered by unit tests that
 * import the module directly — calling process.exit in the same process would
 * abort the test runner.  spawnSync lets us assert the exit code and stdout
 * without affecting the test process.
 *
 * No bloom.db or ROADMAP.md is required; --help must work before any files
 * are opened.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROADMAP_HELP_TEXT } from "../src/roadmap.js";

/** Absolute path to the repo root (one level up from tests/). */
const REPO_ROOT = join(import.meta.dirname, "..");

/** Absolute path to the tsx binary bundled in node_modules. */
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** Absolute path to the roadmap CLI entry point. */
const ROADMAP_SCRIPT = join(REPO_ROOT, "src", "roadmap.ts");

/** Temp directories created during tests; cleaned up in afterEach. */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bloom-roadmap-help-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("roadmap --help exit integration", () => {
  it("exits with code 0 for --help", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [ROADMAP_SCRIPT, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
  });

  it("prints usage text to stdout for --help", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [ROADMAP_SCRIPT, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stdout).toContain("Usage: pnpm roadmap");
  });

  it("stdout matches ROADMAP_HELP_TEXT exactly", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [ROADMAP_SCRIPT, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stdout).toBe(ROADMAP_HELP_TEXT);
  });

  it("emits no stderr for --help", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [ROADMAP_SCRIPT, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stderr ?? "").toBe("");
  });

  it("exits with code 0 for -h alias", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [ROADMAP_SCRIPT, "-h"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: pnpm roadmap");
  });
});
