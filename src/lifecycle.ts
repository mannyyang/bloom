import { execSync, execFileSync } from "child_process";
import { execSyncOutput } from "./errors.js";

/** Timeout for `pnpm build && pnpm test` (2 minutes). */
export const BUILD_TIMEOUT_MS = 120_000;
/** Timeout for git add/commit/tag operations (30 seconds). */
export const GIT_OP_TIMEOUT_MS = 30_000;
/** Timeout for git push operations (60 seconds). */
export const GIT_PUSH_TIMEOUT_MS = 60_000;
/** Timeout for git checkout/clean/reset operations (10 seconds). */
export const GIT_REVERT_TIMEOUT_MS = 10_000;

export interface BuildResult {
  passed: boolean;
  output: string;
}

/**
 * Run `pnpm build && pnpm test` and return pass/fail status with captured output.
 * Shared implementation for both preflight and post-evolution verification.
 */
function runBuildAndTest(): BuildResult {
  try {
    const output = execSync("pnpm build && pnpm test", { encoding: "utf-8", timeout: BUILD_TIMEOUT_MS });
    return { passed: true, output };
  } catch (err: unknown) {
    return { passed: false, output: execSyncOutput(err) };
  }
}

/**
 * Run preflight build+test check. Returns pass/fail status and captured output
 * (used to extract test counts).
 *
 * Note: this is an intentional alias for runBuildAndTest(). The semantic
 * distinction (preflight vs. post-evolution) is meaningful to callers even
 * though the underlying operation is identical. See also verifyBuild().
 */
export function runPreflightCheck(): BuildResult {
  return runBuildAndTest();
}

/**
 * Set git author/committer to the Bloom bot identity via env vars and git config.
 */
export function setGitBotIdentity(): void {
  process.env.GIT_AUTHOR_NAME = "bloom[bot]";
  process.env.GIT_AUTHOR_EMAIL = "bloom[bot]@users.noreply.github.com";
  process.env.GIT_COMMITTER_NAME = "bloom[bot]";
  process.env.GIT_COMMITTER_EMAIL = "bloom[bot]@users.noreply.github.com";
  try {
    execFileSync("git", ["config", "user.name", "bloom[bot]"], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "bloom[bot]@users.noreply.github.com"], { stdio: "ignore" });
  } catch { /* env vars are sufficient fallback */ }
}

/**
 * Stage and commit the bloom.db file. Returns true on success, false if
 * the commit fails (e.g. nothing to commit).
 */
export function commitDb(cycleCount: number, label?: string): boolean {
  try {
    const msg = label ? `cycle ${cycleCount}: ${label}` : `cycle ${cycleCount}`;
    execFileSync("git", ["add", "bloom.db"], { stdio: "inherit", timeout: GIT_OP_TIMEOUT_MS });
    execFileSync("git", ["commit", "-m", msg], { stdio: "inherit", timeout: GIT_OP_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stage and commit the ROADMAP.md file (and regenerate docs/index.html if
 * the generate-pages script is available). Returns true on success, false if
 * the commit fails (e.g. nothing to commit).
 */
export function commitRoadmap(cycleCount: number): boolean {
  try {
    execFileSync("git", ["add", "ROADMAP.md"], { stdio: "inherit", timeout: GIT_OP_TIMEOUT_MS });
    // Regenerate the GitHub Pages viewer so it stays in sync; non-fatal if unavailable.
    try {
      execFileSync("pnpm", ["generate-pages"], { stdio: "inherit", timeout: GIT_OP_TIMEOUT_MS });
      execFileSync("git", ["add", "docs/index.html"], { stdio: "ignore", timeout: GIT_OP_TIMEOUT_MS });
    } catch { /* non-fatal: script may not exist or docs/index.html may be unchanged */ }
    execFileSync("git", ["commit", "-m", `cycle ${cycleCount}: update roadmap`], { stdio: "inherit", timeout: GIT_OP_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Push local commits to origin main. Returns true on success, false on failure.
 */
export function pushChanges(): boolean {
  try {
    execFileSync("git", ["push", "origin", "main"], { stdio: "inherit", timeout: GIT_PUSH_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Push tags to origin. Returns true on success, false on failure.
 */
export function pushTags(): boolean {
  try {
    execFileSync("git", ["push", "--tags"], { stdio: "inherit", timeout: GIT_PUSH_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify build passes after an evolution step.
 * Returns pass/fail status and captured output (used to extract test counts).
 *
 * Note: this is an intentional alias for runBuildAndTest(). The semantic
 * distinction (post-evolution vs. preflight) is meaningful to callers even
 * though the underlying operation is identical. See also runPreflightCheck().
 */
export function verifyBuild(): BuildResult {
  return runBuildAndTest();
}

/**
 * Revert uncommitted changes.
 */
export function revertUncommitted(): void {
  try {
    execFileSync("git", ["checkout", "."], { stdio: "inherit", timeout: GIT_REVERT_TIMEOUT_MS });
  } catch { /* ignore */ }
  try {
    execFileSync("git", ["clean", "-fd"], { stdio: "inherit", timeout: GIT_REVERT_TIMEOUT_MS });
  } catch { /* ignore */ }
}

/**
 * Create a safety tag for the given cycle. Uses execFileSync to avoid shell
 * injection. Returns true on success, false on failure (tag creation is optional).
 */
export function createSafetyTag(cycleCount: number): boolean {
  if (!Number.isInteger(cycleCount) || cycleCount < 1) {
    return false;
  }
  try {
    execFileSync("git", ["tag", "-f", `pre-evolution-cycle-${cycleCount}`], { stdio: "inherit", timeout: GIT_OP_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Post-evolution build verification with retry logic.
 * Attempts up to `maxAttempts` builds, reverting uncommitted changes between
 * attempts. If all attempts fail, performs a hard reset to the safety tag.
 * Returns BuildResult — passed=true if a build eventually passed, passed=false
 * if hard-reset was needed. Output contains the last build's captured output.
 * Throws if the hard-reset itself fails (manual intervention required).
 */
export function runBuildVerification(
  cycleCount: number,
  maxAttempts: number = 3,
): BuildResult {
  let lastResult: BuildResult = { passed: false, output: "" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = verifyBuild();
    if (lastResult.passed) {
      return lastResult;
    }
    console.error(`Build verification failed (attempt ${attempt}/${maxAttempts})`);
    if (attempt < maxAttempts) {
      revertUncommitted();
    }
  }

  console.error("Build broken after all attempts. Reverting to pre-evolution state.");
  hardResetTo(`pre-evolution-cycle-${cycleCount}`);
  return lastResult;
}

/**
 * Validate that a string is a safe git ref (no shell metacharacters).
 */
export function isValidGitRef(ref: string): boolean {
  return /^[a-zA-Z0-9._\-/]+$/.test(ref);
}

/**
 * Hard reset to a specific ref (e.g. a tag).
 * Uses execFileSync to avoid shell injection and validates the ref format.
 */
export function hardResetTo(ref: string): void {
  if (!isValidGitRef(ref)) {
    throw new Error(`Invalid git ref: ${ref}`);
  }
  execFileSync("git", ["reset", "--hard", ref], { stdio: "inherit", timeout: GIT_REVERT_TIMEOUT_MS });
}
