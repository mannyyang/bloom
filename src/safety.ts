import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

export interface ParsedHookInput {
  toolName: string;
  filePath: string;
  command: string;
  oldString: string;
  newString: string;
}

export function denyResult(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

export function parseHookInput(input: unknown): ParsedHookInput {
  const record = input as Record<string, unknown>;
  const toolInput = record.tool_input as Record<string, unknown> | undefined;
  return {
    toolName: String(record.tool_name ?? ""),
    filePath: String(toolInput?.file_path ?? ""),
    command: String(toolInput?.command ?? ""),
    oldString: String(toolInput?.old_string ?? ""),
    newString: String(toolInput?.new_string ?? ""),
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
  const { toolName, filePath, oldString, newString } = parseHookInput(input);

  if (!filePath.includes("JOURNAL.md")) return {};

  if (toolName === "Write") {
    return denyResult("JOURNAL.md is append-only. Use Edit to append, not Write to overwrite.");
  }

  if (toolName === "Edit") {
    if (oldString.length > 0 && !newString.includes(oldString)) {
      return denyResult(
        "JOURNAL.md is append-only. Edit must preserve existing content (new_string must contain old_string).",
      );
    }
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

interface DangerousPattern {
  pattern: RegExp;
  category: string;
}

export const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // Git history destruction — force push overwrites remote history
  { pattern: /git\s+push\s+(-f|--force)/, category: "git-history-destruction" },
  // Git history destruction — hard reset to arbitrary ref loses uncommitted work
  { pattern: /git\s+reset\s+--hard\s+(?!HEAD(?:\s*$|\s*[;&|]))/, category: "git-history-destruction" },
  // Remote code execution — piping downloaded content into a shell
  { pattern: /\bcurl\b.*\|\s*(?:[\w./]*\/)?(?:ba|z|da|k)?sh/, category: "remote-code-execution" },
  { pattern: /\bwget\b.*\|\s*(?:[\w./]*\/)?(?:ba|z|da|k)?sh/, category: "remote-code-execution" },
  // Remote code execution — process substitution download-and-execute
  { pattern: /(?:[\w./]*\/)?(?:ba|z|da|k)?sh\s+<\(\s*(?:curl|wget)\b/, category: "remote-code-execution" },
  // Remote code execution — piping downloaded content into script interpreters
  { pattern: /\bcurl\b.*\|\s*(?:[\w./]*\/)?(?:python3?|node|perl|ruby)\b/, category: "remote-code-execution" },
  { pattern: /\bwget\b.*\|\s*(?:[\w./]*\/)?(?:python3?|node|perl|ruby)\b/, category: "remote-code-execution" },
  // Arbitrary code execution — eval, shell -c run uncontrolled strings
  { pattern: /\beval\s/, category: "arbitrary-code-execution" },
  { pattern: /(?:[\w./]*\/)?(?:ba|z|da|k)?sh\s+-c\b/, category: "arbitrary-code-execution" },
  // Inline interpreter code execution — functionally equivalent to sh -c
  { pattern: /\b(?:python3?|python3\.\d+)\s+-c\b/, category: "inline-code-execution" },
  { pattern: /\bnode\s+(?:-e|--eval)\b/, category: "inline-code-execution" },
  { pattern: /\bperl\s+(?:-e|-E)\b/, category: "inline-code-execution" },
  { pattern: /\bruby\s+-e\b/, category: "inline-code-execution" },
  // Shell script execution — source and dot-script (`. `) execute arbitrary files
  { pattern: /(?:^|[;&|]\s*)source\s/, category: "shell-script-execution" },
  { pattern: /(?:^|[;&|]\s*)\.\s+\S/, category: "shell-script-execution" },
  // Untrusted package execution — npx/npm exec/pnpm exec/pnpm dlx/yarn dlx run arbitrary packages
  { pattern: /\bnpx\s/, category: "untrusted-package-execution" },
  { pattern: /\bnpm\s+exec\b/, category: "untrusted-package-execution" },
  { pattern: /\bpnpm\s+exec\b/, category: "untrusted-package-execution" },
  { pattern: /\bpnpm\s+dlx\s/, category: "untrusted-package-execution" },
  { pattern: /\byarn\s+dlx\s/, category: "untrusted-package-execution" },
  // Git ref destruction — force-delete branches, delete reflog, prune objects
  { pattern: /git\s+branch\s+(-D|--delete\s+--force)\b/, category: "git-ref-destruction" },
  { pattern: /git\s+reflog\s+delete\b/, category: "git-ref-destruction" },
  { pattern: /git\s+gc\s+.*--prune=(now|all)\b/, category: "git-ref-destruction" },
  // Git internals tampering — changing permissions/ownership of .git/
  { pattern: /\bchmod\s+.*\.git\//, category: "git-internals-tampering" },
  { pattern: /\bchown\s+.*\.git\//, category: "git-internals-tampering" },
  // Disk/partition destruction — writing to raw devices or reformatting
  { pattern: /\bdd\s+.*of=\/dev\//, category: "disk-destruction" },
  { pattern: /\bmkfs\b/, category: "disk-destruction" },
  { pattern: /\bwipefs\b/, category: "disk-destruction" },
  { pattern: /\bfdisk\b/, category: "disk-destruction" },
  { pattern: /\bparted\b/, category: "disk-destruction" },
  // Git working tree destruction — force-clean untracked files
  { pattern: /git\s+clean\s+.*(-f|--force)/, category: "git-working-tree-destruction" },
  // Git history rewriting — filter-branch rewrites/removes files from history
  { pattern: /git\s+filter-branch\b/, category: "git-history-rewriting" },
  // Data exfiltration — curl/wget sending data to external servers
  { pattern: /\bcurl\s+.*(-d\b|--data\b|--data-binary\b|--data-raw\b|--data-urlencode\b|--upload-file\b|-F\b|--form\b|--json\b)/, category: "data-exfiltration" },
  { pattern: /\bwget\s+.*--post-(data|file)\b/, category: "data-exfiltration" },
  // xargs command execution bypass — xargs can invoke dangerous commands from stdin
  { pattern: /\bxargs\s+.*(?:[\w./]*\/)?(?:ba|z|da|k)?sh\b/, category: "xargs-command-execution" },
  { pattern: /\bxargs\s+.*\brm\s/, category: "xargs-command-execution" },
  // Untrusted package installation — adding deps pulls arbitrary code
  { pattern: /\bpnpm\s+add\b/, category: "untrusted-package-installation" },
  { pattern: /\bnpm\s+(?:install|i)\s+(?:-\S+\s+)*[a-zA-Z@]/, category: "untrusted-package-installation" },
  { pattern: /\byarn\s+add\b/, category: "untrusted-package-installation" },
];

/**
 * Build an array of RegExp patterns that detect dangerous shell commands
 * targeting a specific protected file.
 *
 * @param filename - A **regex-escaped** filename string (e.g., `"JOURNAL\\.md"`,
 *   not `"JOURNAL.md"`). The value is interpolated directly into `new RegExp(...)`,
 *   so an unescaped `.` would match any character, causing false positives.
 * @param opts.allowAppend - If true, permits append operations (`>>` and `tee -a`)
 *   while still blocking overwrites. Used for JOURNAL.md which is append-only.
 * @returns Array of RegExp patterns covering redirects, cp, mv, sed -i, truncate,
 *   dd, chmod, chown, rm, unlink, ln, git checkout --, and git restore.
 *
 * @example
 * ```ts
 * const patterns = buildProtectedFilePatterns("JOURNAL\\.md", { allowAppend: true });
 * ```
 */
export function buildProtectedFilePatterns(filename: string, opts?: { allowAppend?: boolean }): RegExp[] {
  const patterns: RegExp[] = [
    // Redirect: for append-allowed files, only block overwrite (>); otherwise block both (> and >>)
    opts?.allowAppend
      ? new RegExp(`(?:^|[^>])>\\s*(?:\\S*\\/)?${filename}`)
      : new RegExp(`(?:>|>>)\\s*(?:\\S*\\/)?${filename}`),
    // tee: for append-allowed files, allow tee -a; otherwise block all tee
    opts?.allowAppend
      ? new RegExp(`\\btee\\s+(?!.*-\\w*a)(?:.*\\s)?(?:\\S*\\/)?${filename}`)
      : new RegExp(`\\btee\\s+(?:.*\\s)?(?:\\S*\\/)?${filename}`),
    new RegExp(`\\bcp\\s+(?:.*\\s)?(?:\\S*\\/)?${filename}(?:\\s|$|;|&|\\|)`),
    new RegExp(`\\bmv\\s+(?:.*\\s)?(?:\\S*\\/)?${filename}(?:\\s|$|;|&|\\|)`),
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

export function isDangerousCommand(command: string): string | null {
  for (const { pattern, category } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return category;
    }
  }
  return null;
}

export const blockDangerousCommands: HookCallback = async (input) => {
  const { toolName, command } = parseHookInput(input);
  if (toolName !== "Bash") return {};

  if (isDangerousRm(command)) {
    return denyResult(`Blocked dangerous command: ${command}`);
  }

  const category = isDangerousCommand(command);
  if (category) {
    return denyResult(`Blocked [${category}]: pattern matched in command`);
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
