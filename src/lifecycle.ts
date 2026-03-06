import { execSync, execFileSync } from "child_process";

/**
 * Run preflight build+test check. Returns true if passed, false if failed.
 */
export function runPreflightCheck(): boolean {
  try {
    execSync("pnpm build && pnpm test", { stdio: "inherit", timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
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
 * Stage and commit the CYCLE_COUNT file. Returns true on success, false if
 * the commit fails (e.g. nothing to commit).
 */
export function commitCycleCount(cycleCount: number): boolean {
  try {
    execFileSync("git", ["add", "CYCLE_COUNT"], { stdio: "inherit", timeout: 30_000 });
    execFileSync("git", ["commit", "-m", `cycle ${cycleCount}`], { stdio: "inherit", timeout: 30_000 });
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
    execSync("git push origin main", { stdio: "inherit", timeout: 60_000 });
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
    execSync("git push --tags", { stdio: "inherit", timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify build passes. Used for post-evolution verification.
 */
export function verifyBuild(): boolean {
  try {
    execSync("pnpm build && pnpm test", { stdio: "inherit", timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Revert uncommitted changes.
 */
export function revertUncommitted(): void {
  try {
    execSync("git checkout .", { stdio: "inherit", timeout: 10_000 });
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
    execFileSync("git", ["tag", "-f", `pre-evolution-cycle-${cycleCount}`], { stdio: "inherit", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Post-evolution build verification with retry logic.
 * Attempts up to `maxAttempts` builds, reverting uncommitted changes between
 * attempts. If all attempts fail, performs a hard reset to the safety tag.
 * Returns true if a build eventually passed, false if hard-reset was needed.
 * Throws if the hard-reset itself fails (manual intervention required).
 */
export function runBuildVerification(
  cycleCount: number,
  maxAttempts: number = 3,
): boolean {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (verifyBuild()) {
      return true;
    }
    console.error(`Build verification failed (attempt ${attempt}/${maxAttempts})`);
    if (attempt < maxAttempts) {
      revertUncommitted();
    }
  }

  console.error("Build broken after all attempts. Reverting to pre-evolution state.");
  hardResetTo(`pre-evolution-cycle-${cycleCount}`);
  return false;
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
  execFileSync("git", ["reset", "--hard", ref], { stdio: "inherit", timeout: 10_000 });
}
