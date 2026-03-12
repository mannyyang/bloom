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
