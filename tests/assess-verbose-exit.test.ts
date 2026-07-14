/**
 * Integration test for the --verbose flag in assess.ts.
 *
 * When --verbose is passed, assess.ts prints the fully-built assessment
 * prompt and returns without making any LLM call.  This path cannot be
 * fully exercised by unit tests alone: the subprocess level confirms that
 * the real process.argv is parsed correctly and that the process exits 0
 * without requiring API credentials.
 *
 * Context loading (DB, IDENTITY.md, ROADMAP.md) is non-fatal, so the
 * subprocess runs to the verbose-print step even in an empty temp directory.
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

/** Absolute path to the assess CLI entry point. */
const ASSESS_SCRIPT = join(REPO_ROOT, "src", "assess.ts");

/** Temp directories created during tests; cleaned up in afterEach. */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bloom-assess-verbose-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("assess --verbose exit integration", () => {
  it("exits with code 0 for --verbose", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [ASSESS_SCRIPT, "--verbose"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
  });

  it("stdout contains the Assessment Prompt banner for --verbose", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [ASSESS_SCRIPT, "--verbose"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stdout).toContain("Assessment Prompt");
  });

  it("stdout contains --verbose marker line for --verbose", () => {
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [ASSESS_SCRIPT, "--verbose"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.stdout).toContain("--verbose: printing prompt (no LLM call)");
  });

  it("process does not hang waiting for LLM credentials with --verbose", () => {
    // Guard: if --verbose accidentally falls through to the LLM query loop,
    // the subprocess would block or error on missing credentials. A clean
    // exit within the timeout proves the early-return path is taken.
    const dir = makeTempDir();
    const result = spawnSync(TSX_BIN, [ASSESS_SCRIPT, "--verbose"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15000,
    });

    // Non-null status means the process exited (did not time out)
    expect(result.status).not.toBeNull();
    expect(result.status).toBe(0);
  });
});
