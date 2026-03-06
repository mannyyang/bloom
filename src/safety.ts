import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

interface ParsedHookInput {
  toolName: string;
  filePath: string;
  command: string;
}

function denyResult(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
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
    return denyResult("IDENTITY.md is the immutable constitution and cannot be modified.");
  }
  return {};
};

export const enforceAppendOnly: HookCallback = async (input) => {
  const { toolName, filePath } = parseHookInput(input);

  if (filePath.includes("JOURNAL.md") && toolName === "Write") {
    return denyResult("JOURNAL.md is append-only. Use Edit to append, not Write to overwrite.");
  }
  return {};
};

export function isDangerousRm(command: string): boolean {
  // Match `rm` followed by flags that include both -r (or --recursive) and -f (or --force)
  // targeting / or ~ . Handles: rm -rf /, rm -r -f /, rm -f -r /, rm -fr /, rm --recursive --force /, etc.
  const rmMatch = command.match(/\brm\s+(.*)/);
  if (!rmMatch) return false;
  const rest = rmMatch[1];

  // Block --no-preserve-root unconditionally — it has no legitimate use in Bloom
  if (/--no-preserve-root/.test(rest)) return true;

  const hasRecursive = /(?:^|\s)--recursive(?:\s|$)/.test(rest) || /(?:^|\s)-\w*r/.test(rest);
  const hasForce = /(?:^|\s)--force(?:\s|$)/.test(rest) || /(?:^|\s)-\w*f/.test(rest);
  const hasDangerousPath = /(?:^|\s)\/(?:\s|$|\*)/.test(rest) || /(?:^|\s)~\/?(?:\s|$|\*)/.test(rest);

  // Critical system directories — no legitimate use in Bloom's context
  const CRITICAL_DIRS = /(?:^|\s)\/(?:etc|usr|var|boot|bin|sbin|lib|proc|sys)(?:\/?\s|\/?\*|\/?\||\/?;|\/?&|\/?$)/;
  const hasCriticalPath = CRITICAL_DIRS.test(rest);

  return hasRecursive && hasForce && (hasDangerousPath || hasCriticalPath);
}

const DANGEROUS_PATTERNS = [
  /git\s+push\s+(-f|--force)/,
  /git\s+reset\s+--hard\s+(?!HEAD\s*$)/,
  /curl.*\|\s*(?:[\w./]*\/)?(?:ba|z|da|k)?sh/,
  /wget.*\|\s*(?:[\w./]*\/)?(?:ba|z|da|k)?sh/,
  /\beval\s/,
  /(?:[\w./]*\/)?bash\s+-c\b/,
  /(?:[\w./]*\/)?sh\s+-c\b/,
  /\bnpx\s/,
  /\bnpm\s+exec\b/,
  /git\s+branch\s+(-D|--delete\s+--force)\b/,
  /git\s+reflog\s+delete\b/,
  /git\s+gc\s+.*--prune=(now|all)\b/,
  /\bchmod\s+.*\.git\//,
  /\bchown\s+.*\.git\//,
  /\bdd\s+.*of=\/dev\//,
  /\bmkfs\b/,
  /\bwipefs\b/,
  /\bfdisk\b/,
  /\bparted\b/,
  /git\s+clean\s+.*(-f|--force)/,
  /\bcurl\s+.*(-d\b|--data\b|--data-binary\b|--data-raw\b|--data-urlencode\b|--upload-file\b|-F\b|--form\b)/,
  /\bwget\s+.*--post-(data|file)\b/,
];

const JOURNAL_MODIFY_PATTERNS = [
  /(?:^|[^>])>\s*(?:\S*\/)?JOURNAL\.md/,
  /\btee\s+(?!.*-a)(?:.*\s)?(?:\S*\/)?JOURNAL\.md/,
  /\bcp\s+(?:.*\s)(?:\S*\/)?JOURNAL\.md(?:\s|$|;|&|\|)/,
  /\bmv\s+(?:.*\s)(?:\S*\/)?JOURNAL\.md(?:\s|$|;|&|\|)/,
  /\bsed\s+-i\b.*JOURNAL\.md/,
  /\btruncate\s+.*JOURNAL\.md/,
  /\bdd\s+.*of=(?:\S*\/)?JOURNAL\.md/,
  /\bchmod\s+.*JOURNAL\.md/,
  /\bchown\s+.*JOURNAL\.md/,
  /\brm\s+.*JOURNAL\.md/,
  /\bunlink\s+.*JOURNAL\.md/,
  /(?:^|[;&|]\s*|\s)ln\s+.*JOURNAL\.md/,
  /git\s+checkout\s+.*--\s+.*JOURNAL\.md/,
  /git\s+restore\s+.*JOURNAL\.md/,
];

const IDENTITY_MODIFY_PATTERNS = [
  /(?:>|>>)\s*(?:\S*\/)?IDENTITY\.md/,
  /\btee\s+(?:.*\s)?(?:\S*\/)?IDENTITY\.md/,
  /\bcp\s+(?:.*\s)(?:\S*\/)?IDENTITY\.md(?:\s|$|;|&|\|)/,
  /\bmv\s+(?:.*\s)(?:\S*\/)?IDENTITY\.md(?:\s|$|;|&|\|)/,
  /\bsed\s+-i\b.*IDENTITY\.md/,
  /\bchmod\s+.*IDENTITY\.md/,
  /\bchown\s+.*IDENTITY\.md/,
  /\btruncate\s+.*IDENTITY\.md/,
  /\bdd\s+.*of=(?:\S*\/)?IDENTITY\.md/,
  /\brm\s+.*IDENTITY\.md/,
  /\bunlink\s+.*IDENTITY\.md/,
  /(?:^|[;&|]\s*|\s)ln\s+.*IDENTITY\.md/,
  /git\s+checkout\s+.*--\s+.*IDENTITY\.md/,
  /git\s+restore\s+.*IDENTITY\.md/,
];

export const blockDangerousCommands: HookCallback = async (input) => {
  const { toolName, command } = parseHookInput(input);
  if (toolName !== "Bash") return {};

  if (isDangerousRm(command)) {
    return denyResult(`Blocked dangerous command: ${command}`);
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return denyResult(`Blocked dangerous command: ${command}`);
    }
  }

  for (const pattern of IDENTITY_MODIFY_PATTERNS) {
    if (pattern.test(command)) {
      return denyResult("IDENTITY.md is the immutable constitution and cannot be modified via Bash.");
    }
  }

  for (const pattern of JOURNAL_MODIFY_PATTERNS) {
    if (pattern.test(command)) {
      return denyResult("JOURNAL.md is append-only and cannot be overwritten via Bash.");
    }
  }

  return {};
};
