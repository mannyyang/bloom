import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { fetchCommunityIssues, closeIssueWithComment, isValidRepo, isSafeIssueNumber, detectRepo } from "../src/issues.js";
import { githubApiRequest } from "../src/github-app.js";
import { initDb, hasIssueAction } from "../src/db.js";

vi.mock("../src/github-app.js", () => ({
  githubApiRequest: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

const mockGithubApiRequest = vi.mocked(githubApiRequest);

describe("isValidRepo", () => {
  it("accepts a standard owner/repo format", () => {
    expect(isValidRepo("owner/repo")).toBe(true);
  });

  it("accepts repos with dots and hyphens", () => {
    expect(isValidRepo("my-org/my.repo-name")).toBe(true);
  });

  it("rejects repo without slash", () => {
    expect(isValidRepo("just-a-name")).toBe(false);
  });

  it("rejects shell command substitution $(...)", () => {
    expect(isValidRepo("$(whoami)/repo")).toBe(false);
  });

  it("rejects pipe characters", () => {
    expect(isValidRepo("owner/repo | cat /etc/passwd")).toBe(false);
  });

  it("rejects backtick injection", () => {
    expect(isValidRepo("owner/`id`")).toBe(false);
  });

  it("rejects embedded newlines", () => {
    expect(isValidRepo("owner/repo\nrm -rf /")).toBe(false);
  });

  it("rejects semicolon injection", () => {
    expect(isValidRepo("owner/repo; echo pwned")).toBe(false);
  });
});

describe("detectRepo (direct)", () => {
  const originalEnv = process.env.GITHUB_REPOSITORY;

  afterEach(() => {
    mockExecFileSync.mockReset();
    if (originalEnv !== undefined) {
      process.env.GITHUB_REPOSITORY = originalEnv;
    } else {
      delete process.env.GITHUB_REPOSITORY;
    }
  });

  it("returns GITHUB_REPOSITORY env var when set", () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    expect(detectRepo()).toBe("owner/repo");
  });

  it("prefers GITHUB_REPOSITORY over git remote", () => {
    process.env.GITHUB_REPOSITORY = "env-owner/env-repo";
    mockExecFileSync.mockReturnValueOnce("https://github.com/git-owner/git-repo.git\n");
    expect(detectRepo()).toBe("env-owner/env-repo");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("falls back to parsing HTTPS git remote URL", () => {
    delete process.env.GITHUB_REPOSITORY;
    mockExecFileSync.mockReturnValueOnce("https://github.com/owner/repo.git\n");
    expect(detectRepo()).toBe("owner/repo");
  });

  it("falls back to parsing SSH git remote URL", () => {
    delete process.env.GITHUB_REPOSITORY;
    mockExecFileSync.mockReturnValueOnce("git@github.com:my-org/my-repo.git\n");
    expect(detectRepo()).toBe("my-org/my-repo");
  });

  it("parses HTTPS remote URL without .git suffix", () => {
    delete process.env.GITHUB_REPOSITORY;
    mockExecFileSync.mockReturnValueOnce("https://github.com/owner/repo\n");
    expect(detectRepo()).toBe("owner/repo");
  });

  it("returns null for non-GitHub remote", () => {
    delete process.env.GITHUB_REPOSITORY;
    mockExecFileSync.mockReturnValueOnce("https://gitlab.com/owner/repo.git\n");
    expect(detectRepo()).toBeNull();
  });

  it("returns null when git remote throws (no git repo)", () => {
    delete process.env.GITHUB_REPOSITORY;
    mockExecFileSync.mockImplementationOnce(() => { throw new Error("not a git repo"); });
    expect(detectRepo()).toBeNull();
  });
});

describe("fetchCommunityIssues", () => {
  const originalEnv = process.env.GITHUB_REPOSITORY;

  afterEach(() => {
    mockGithubApiRequest.mockReset();
    mockExecFileSync.mockReset();
    if (originalEnv !== undefined) {
      process.env.GITHUB_REPOSITORY = originalEnv;
    } else {
      delete process.env.GITHUB_REPOSITORY;
    }
  });

  it("returns empty array when repo format is invalid", async () => {
    process.env.GITHUB_REPOSITORY = "not-a-valid-repo";
    const result = await fetchCommunityIssues();
    expect(result).toEqual([]);
  });

  it("returns empty array when API call fails", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    mockGithubApiRequest.mockResolvedValueOnce({ ok: false } as Response);
    const result = await fetchCommunityIssues();
    expect(result).toEqual([]);
  });

  it("returns empty array for malicious repo containing shell metacharacters", async () => {
    process.env.GITHUB_REPOSITORY = "foo/bar; rm -rf ~";
    const result = await fetchCommunityIssues();
    expect(result).toEqual([]);
  });

  it("returns empty array for repo with backtick injection attempt", async () => {
    process.env.GITHUB_REPOSITORY = "foo/`whoami`";
    const result = await fetchCommunityIssues();
    expect(result).toEqual([]);
  });

  it("returns issues sorted by reaction count descending", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    mockGithubApiRequest.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { number: 1, title: "Low", body: "b1", reactions: { total_count: 2 } },
        { number: 2, title: "High", body: "b2", reactions: { total_count: 10 } },
      ],
    } as unknown as Response);

    const result = await fetchCommunityIssues();
    expect(result).toEqual([
      { number: 2, title: "High", body: "b2", reactions: 10 },
      { number: 1, title: "Low", body: "b1", reactions: 2 },
    ]);

    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      "GET",
      "/repos/owner/repo/issues?labels=agent-input&state=open&per_page=20",
    );
  });

  it("returns empty array when githubApiRequest throws (network error)", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    mockGithubApiRequest.mockRejectedValueOnce(new Error("network failure"));
    const result = await fetchCommunityIssues();
    expect(result).toEqual([]);
  });

  it("returns empty array when API returns a non-array (rate-limit object)", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    mockGithubApiRequest.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: "API rate limit exceeded", documentation_url: "https://..." }),
    } as unknown as Response);
    const result = await fetchCommunityIssues();
    expect(result).toEqual([]);
  });

  it("filters out items missing required fields (number, title)", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    mockGithubApiRequest.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { number: 1, title: "Valid", body: "b", reactions: { total_count: 1 } },
        { title: "No number", body: "b", reactions: { total_count: 0 } },
        { number: 3, body: "No title", reactions: { total_count: 0 } },
        null,
        "string-item",
      ],
    } as unknown as Response);
    const result = await fetchCommunityIssues();
    expect(result).toEqual([{ number: 1, title: "Valid", body: "b", reactions: 1 }]);
  });

  it("defaults body to empty string and reactions to 0 when missing", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    mockGithubApiRequest.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { number: 5, title: "Minimal" },
      ],
    } as unknown as Response);
    const result = await fetchCommunityIssues();
    expect(result).toEqual([{ number: 5, title: "Minimal", body: "", reactions: 0 }]);
  });
});

describe("fetchCommunityIssues — detectRepo git remote fallback", () => {
  const originalEnv = process.env.GITHUB_REPOSITORY;

  afterEach(() => {
    mockGithubApiRequest.mockReset();
    mockExecFileSync.mockReset();
    if (originalEnv !== undefined) {
      process.env.GITHUB_REPOSITORY = originalEnv;
    } else {
      delete process.env.GITHUB_REPOSITORY;
    }
  });

  it("parses HTTPS remote URL", async () => {
    delete process.env.GITHUB_REPOSITORY;
    mockExecFileSync.mockReturnValueOnce("https://github.com/owner/repo.git\n");
    mockGithubApiRequest.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ number: 1, title: "T", body: "", reactions: { total_count: 0 } }],
    } as unknown as Response);

    const result = await fetchCommunityIssues();
    expect(result).toHaveLength(1);
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      "GET",
      "/repos/owner/repo/issues?labels=agent-input&state=open&per_page=20",
    );
  });

  it("parses SSH remote URL", async () => {
    delete process.env.GITHUB_REPOSITORY;
    mockExecFileSync.mockReturnValueOnce("git@github.com:my-org/my-repo.git\n");
    mockGithubApiRequest.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as unknown as Response);

    const result = await fetchCommunityIssues();
    expect(result).toEqual([]);
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      "GET",
      "/repos/my-org/my-repo/issues?labels=agent-input&state=open&per_page=20",
    );
  });

  it("parses HTTPS remote URL without .git suffix", async () => {
    delete process.env.GITHUB_REPOSITORY;
    mockExecFileSync.mockReturnValueOnce("https://github.com/owner/repo\n");
    mockGithubApiRequest.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as unknown as Response);

    await fetchCommunityIssues();
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      "GET",
      "/repos/owner/repo/issues?labels=agent-input&state=open&per_page=20",
    );
  });

  it("returns empty array for non-GitHub remote", async () => {
    delete process.env.GITHUB_REPOSITORY;
    mockExecFileSync.mockReturnValueOnce("https://gitlab.com/owner/repo.git\n");

    const result = await fetchCommunityIssues();
    expect(result).toEqual([]);
    expect(mockGithubApiRequest).not.toHaveBeenCalled();
  });

  it("returns empty array when execSync throws (no git remote)", async () => {
    delete process.env.GITHUB_REPOSITORY;
    mockExecFileSync.mockImplementationOnce(() => { throw new Error("not a git repo"); });

    const result = await fetchCommunityIssues();
    expect(result).toEqual([]);
    expect(mockGithubApiRequest).not.toHaveBeenCalled();
  });
});

describe("isSafeIssueNumber", () => {
  it("accepts a positive integer", () => {
    expect(isSafeIssueNumber(42)).toBe(true);
  });

  it("rejects NaN", () => {
    expect(isSafeIssueNumber(NaN)).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(isSafeIssueNumber(Infinity)).toBe(false);
  });

  it("rejects zero", () => {
    expect(isSafeIssueNumber(0)).toBe(false);
  });

  it("rejects negative numbers", () => {
    expect(isSafeIssueNumber(-1)).toBe(false);
  });

  it("rejects floats", () => {
    expect(isSafeIssueNumber(1.5)).toBe(false);
  });
});

describe("closeIssueWithComment", () => {
  const originalEnv = process.env.GITHUB_REPOSITORY;

  afterEach(() => {
    mockGithubApiRequest.mockReset();
    if (originalEnv !== undefined) {
      process.env.GITHUB_REPOSITORY = originalEnv;
    } else {
      delete process.env.GITHUB_REPOSITORY;
    }
  });

  it("posts a custom comment and closes the issue", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    mockGithubApiRequest.mockResolvedValueOnce({ ok: true } as Response);
    mockGithubApiRequest.mockResolvedValueOnce({ ok: true } as Response);

    const result = await closeIssueWithComment(5, 10, "Custom triage message");
    expect(result).toBe(true);
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      "POST",
      "/repos/owner/repo/issues/5/comments",
      { body: "Custom triage message" },
    );
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      "PATCH",
      "/repos/owner/repo/issues/5",
      { state: "closed" },
    );
  });

  it("uses custom action type for DB idempotency", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const db = initDb(":memory:");
    db.prepare("INSERT INTO cycles (cycle_number, started_at) VALUES (?, ?)").run(10, new Date().toISOString());

    mockGithubApiRequest.mockResolvedValueOnce({ ok: true } as Response);
    mockGithubApiRequest.mockResolvedValueOnce({ ok: true } as Response);

    await closeIssueWithComment(5, 10, "Triaged", db, "triaged");
    expect(hasIssueAction(db, 5, "triaged")).toBe(true);

    // Second call skips
    mockGithubApiRequest.mockReset();
    const result = await closeIssueWithComment(5, 10, "Triaged", db, "triaged");
    expect(result).toBe(true);
    expect(mockGithubApiRequest).not.toHaveBeenCalled();

    db.close();
  });
});

