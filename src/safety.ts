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
  // Git history destruction — force push overwrites remote history
  /git\s+push\s+(-f|--force)/,
  // Git history destruction — hard reset to arbitrary ref loses uncommitted work
  /git\s+reset\s+--hard\s+(?!HEAD(?:\s*$|\s*[;&|]))/,
  // Remote code execution — piping downloaded content into a shell
  /curl.*\|\s*(?:[\w./]*\/)?(?:ba|z|da|k)?sh/,
  /wget.*\|\s*(?:[\w./]*\/)?(?:ba|z|da|k)?sh/,
  // Arbitrary code execution — eval, bash -c, sh -c run uncontrolled strings
  /\beval\s/,
  /(?:[\w./]*\/)?bash\s+-c\b/,
  /(?:[\w./]*\/)?sh\s+-c\b/,
  // Untrusted package execution — npx/npm exec/pnpm exec/pnpm dlx/yarn dlx run arbitrary packages
  /\bnpx\s/,
  /\bnpm\s+exec\b/,
  /\bpnpm\s+exec\b/,
  /\bpnpm\s+dlx\s/,
  /\byarn\s+dlx\s/,
  // Git ref destruction — force-delete branches, delete reflog, prune objects
  /git\s+branch\s+(-D|--delete\s+--force)\b/,
  /git\s+reflog\s+delete\b/,
  /git\s+gc\s+.*--prune=(now|all)\b/,
  // Git internals tampering — changing permissions/ownership of .git/
  /\bchmod\s+.*\.git\//,
  /\bchown\s+.*\.git\//,
  // Disk/partition destruction — writing to raw devices or reformatting
  /\bdd\s+.*of=\/dev\//,
  /\bmkfs\b/,
  /\bwipefs\b/,
  /\bfdisk\b/,
  /\bparted\b/,
  // Git working tree destruction — force-clean untracked files
  /git\s+clean\s+.*(-f|--force)/,
  // Data exfiltration — curl/wget sending data to external servers
  /\bcurl\s+.*(-d\b|--data\b|--data-binary\b|--data-raw\b|--data-urlencode\b|--upload-file\b|-F\b|--form\b)/,
  /\bwget\s+.*--post-(data|file)\b/,
  // Untrusted package installation — adding deps pulls arbitrary code
  /\bpnpm\s+add\b/,
  /\bnpm\s+install\s+(?:-\S+\s+)*[a-zA-Z@]/,
  /\byarn\s+add\b/,
];

function buildProtectedFilePatterns(filename: string, opts?: { allowAppend?: boolean }): RegExp[] {
  const patterns: RegExp[] = [
    // Redirect: for append-allowed files, only block overwrite (>); otherwise block both (> and >>)
    opts?.allowAppend
      ? new RegExp(`(?:^|[^>])>\\s*(?:\\S*\\/)?${filename}`)
      : new RegExp(`(?:>|>>)\\s*(?:\\S*\\/)?${filename}`),
    // tee: for append-allowed files, allow tee -a; otherwise block all tee
    opts?.allowAppend
      ? new RegExp(`\\btee\\s+(?!.*-a)(?:.*\\s)?(?:\\S*\\/)?${filename}`)
      : new RegExp(`\\btee\\s+(?:.*\\s)?(?:\\S*\\/)?${filename}`),
    new RegExp(`\\bcp\\s+(?:.*\\s)(?:\\S*\\/)?${filename}(?:\\s|$|;|&|\\|)`),
    new RegExp(`\\bmv\\s+(?:.*\\s)(?:\\S*\\/)?${filename}(?:\\s|$|;|&|\\|)`),
    new RegExp(`\\bsed\\s+-i\\b.*${filename}`),
    new RegExp(`\\btruncate\\s+.*${filename}`),
    new RegExp(`\\bdd\\s+.*of=(?:\\S*\\/)?${filename}`),
    new RegExp(`\\bchmod\\s+.*${filename}`),
    new RegExp(`\\bchown\\s+.*${filename}`),
    new RegExp(`\\brm\\s+.*${filename}`),
    new RegExp(`\\bunlink\\s+.*${filename}`),
    new RegExp(`(?:^|[;&|]\\s*|\\s)ln\\s+.*${filename}`),
    new RegExp(`git\\s+checkout\\s+.*--\\s+.*${filename}`),
    new RegExp(`git\\s+restore\\s+.*${filename}`),
  ];
  return patterns;
}

const JOURNAL_MODIFY_PATTERNS = buildProtectedFilePatterns("JOURNAL\\.md", { allowAppend: true });
const IDENTITY_MODIFY_PATTERNS = buildProtectedFilePatterns("IDENTITY\\.md");

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
