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
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
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
  const stdout =
    "stdout" in err && typeof (err as Record<string, unknown>).stdout === "string"
      ? ((err as Record<string, unknown>).stdout as string)
      : "";
  const stderr =
    "stderr" in err && typeof (err as Record<string, unknown>).stderr === "string"
      ? ((err as Record<string, unknown>).stderr as string)
      : "";
  return (stdout + stderr).trim();
}
