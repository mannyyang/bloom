/**
 * Safe error-message extraction utility.
 * Handles all thrown types — Error objects, strings, nulls, objects, etc.
 */

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
  const stdout =
    "stdout" in err && typeof rec.stdout === "string" ? rec.stdout : "";
  const stderr =
    "stderr" in err && typeof rec.stderr === "string" ? rec.stderr : "";
  return (stdout + stderr).trim();
}
