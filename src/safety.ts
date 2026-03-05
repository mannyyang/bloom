import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

export const protectIdentity: HookCallback = async (input) => {
  const toolInput = (input as Record<string, unknown>).tool_input as
    | Record<string, unknown>
    | undefined;
  const filePath = (toolInput?.file_path as string) ?? "";

  if (filePath.includes("IDENTITY.md")) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "IDENTITY.md is the immutable constitution and cannot be modified.",
      },
    };
  }
  return {};
};

export const enforceAppendOnly: HookCallback = async (input) => {
  const record = input as Record<string, unknown>;
  const toolName = record.tool_name as string | undefined;
  const toolInput = record.tool_input as Record<string, unknown> | undefined;
  const filePath = (toolInput?.file_path as string) ?? "";

  if (filePath.includes("JOURNAL.md") && toolName === "Write") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "JOURNAL.md is append-only. Use Edit to append, not Write to overwrite.",
      },
    };
  }
  return {};
};

export const blockDangerousCommands: HookCallback = async (input) => {
  const record = input as Record<string, unknown>;
  const toolName = record.tool_name as string | undefined;
  if (toolName !== "Bash") return {};

  const toolInput = record.tool_input as Record<string, unknown> | undefined;
  const command = (toolInput?.command as string) ?? "";

  const dangerous = [
    /rm\s+-rf\s+[\/~]/,
    /git\s+push\s+--force/,
    /git\s+reset\s+--hard(?!\s+HEAD)/,
    /curl.*\|\s*sh/,
  ];

  for (const pattern of dangerous) {
    if (pattern.test(command)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Blocked dangerous command: ${command}`,
        },
      };
    }
  }
  return {};
};
