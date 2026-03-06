import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

interface ParsedHookInput {
  toolName: string;
  filePath: string;
  command: string;
}

function parseHookInput(input: unknown): ParsedHookInput {
  const record = input as Record<string, unknown>;
  const toolInput = record.tool_input as Record<string, unknown> | undefined;
  return {
    toolName: (record.tool_name as string) ?? "",
    filePath: (toolInput?.file_path as string) ?? "",
    command: (toolInput?.command as string) ?? "",
  };
}

export const protectIdentity: HookCallback = async (input) => {
  const { filePath } = parseHookInput(input);

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
  const { toolName, filePath } = parseHookInput(input);

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
  const { toolName, command } = parseHookInput(input);
  if (toolName !== "Bash") return {};

  const dangerous = [
    /rm\s+-rf\s+[\/~]/,
    /git\s+push\s+(-f|--force)/,
    /git\s+reset\s+--hard(?!\s+HEAD\s*$)/,
    /curl.*\|\s*sh/,
    /wget.*\|\s*sh/,
    /\beval\s/,
    /\bbash\s+-c\b/,
    /\bsh\s+-c\b/,
    /\bnpx\s/,
    /\bnpm\s+exec\b/,
    /git\s+branch\s+(-D|--delete\s+--force)\b/,
    /git\s+reflog\s+delete\b/,
    /git\s+gc\s+.*--prune=(now|all)\b/,
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
