import { execSync } from "child_process";

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
    execSync('git config user.name "bloom[bot]"', { stdio: "ignore" });
    execSync('git config user.email "bloom[bot]@users.noreply.github.com"', { stdio: "ignore" });
  } catch { /* env vars are sufficient fallback */ }
}

/**
 * Stage and commit the CYCLE_COUNT file. Returns true on success, false if
 * the commit fails (e.g. nothing to commit).
 */
export function commitCycleCount(cycleCount: number): boolean {
  try {
    execSync(`git add CYCLE_COUNT && git commit -m "cycle ${cycleCount}"`, { stdio: "inherit", timeout: 30_000 });
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
 * Hard reset to a specific ref (e.g. a tag).
 */
export function hardResetTo(ref: string): void {
  execSync(`git reset --hard ${ref}`, { stdio: "inherit", timeout: 10_000 });
}
