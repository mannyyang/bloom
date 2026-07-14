/**
 * Integration test for --help / -h exit behaviour in assess.ts.
 *
 * process.exit(0) inside assess main() cannot be covered by unit tests that
 * import the module directly — calling process.exit in the same process would
 * abort the test runner.  spawnSync lets us assert the exit code and stdout
 * without affecting the test process.
 *
 * No bloom.db or IDENTITY.md is required; --help must work before any files
 * are opened.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSESS_HELP_TEXT } from "../src/assess.js";

/** Absolute path to the repo root (one level up from tests/). */
const REPO_ROOT = join(import.meta.dirname, "..");

/** Absolute path to the tsx binary bundled in node_modules. */
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** Absolute path to the assess CLI entry point. */
const ASSESS_SCRIPT = join(REPO_ROOT, "src", "assess.ts");

/** Temp directories created during tests; cleaned up in afterEach. */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bloom-assess-help-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("assess --help exit integration", () => {
  it("exits with code 0 for --help", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [ASSESS_SCRIPT, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
  });

  it("prints usage text to stdout for --help", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [ASSESS_SCRIPT, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stdout).toContain("Usage: pnpm assess");
  });

  it("stdout matches ASSESS_HELP_TEXT exactly", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [ASSESS_SCRIPT, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stdout).toBe(ASSESS_HELP_TEXT);
  });

  it("emits no stderr for --help", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [ASSESS_SCRIPT, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stderr ?? "").toBe("");
  });

  it("exits with code 0 for -h alias", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [ASSESS_SCRIPT, "-h"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: pnpm assess");
  });
});
