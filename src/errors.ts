/**
 * Safe error-message extraction utility.
 * Handles all thrown types — Error objects, strings, nulls, objects, etc.
 */

/**
 * Category of failure for an evolution cycle.
 * Enables pattern detection — e.g., "test failures dominate losses."
 *
 * - 'build_failure': TypeScript compiler error; pnpm build failed before tests ran.
 * - 'test_failure': Build succeeded but one or more vitest tests failed.
 * - 'llm_error': The evolution agent or assessment phase threw an unhandled error.
 * - 'none': No failure — cycle completed successfully.
 */
export type ErrorCategory = "build_failure" | "test_failure" | "llm_error" | "none";

/**
 * Extract a human-readable message from an unknown thrown value.
 * Handles Error instances, strings, objects with a message property, and fallbacks.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as Record<string, unknown>).message === "string"
  ) {
    return (err as Record<string, unknown>).message as string;
  }
  return String(err);
}

/**
 * Safely extract stdout+stderr output from a failed `execSync` / `execFileSync` call.
 * Node's child_process throws an object with `stdout` and `stderr` properties on failure,
 * but we cannot assume the thrown value conforms to that shape.
 */
export function execSyncOutput(err: unknown): string {
  if (err == null || typeof err !== "object") return "";
  const rec = err as Record<string, unknown>;
  const toStr = (val: unknown): string => {
    if (typeof val === "string") return val;
    if (Buffer.isBuffer(val)) return val.toString();
    return "";
  };
  const stdout = "stdout" in err ? toStr(rec.stdout) : "";
  const stderr = "stderr" in err ? toStr(rec.stderr) : "";
  return (stdout + stderr).trim();
}
