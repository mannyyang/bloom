import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { fetchCommunityIssues, closeIssueWithComment, isValidRepo, isSafeIssueNumber, detectRepo, syncReactionsToItems } from "../src/issues.js";
import { githubApiRequest } from "../src/github-app.js";
import { initDb, hasIssueAction } from "../src/db.js";
import type { ProjectItem } from "../src/planning.js";

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

  it("logs console.error with message when githubApiRequest throws", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    mockGithubApiRequest.mockRejectedValueOnce(new Error("connection timeout"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchCommunityIssues();

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[issues] fetchCommunityIssues failed (non-fatal)"),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("connection timeout"));
    errorSpy.mockRestore();
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

function makeItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    id: "item-1",
    title: "Test item",
    status: "Backlog",
    body: "",
    linkedIssueNumber: null,
    reactions: 0,
    ...overrides,
  };
}

describe("syncReactionsToItems", () => {
  const originalEnv = process.env.GITHUB_REPOSITORY;

  afterEach(() => {
    mockGithubApiRequest.mockReset();
    if (originalEnv !== undefined) {
      process.env.GITHUB_REPOSITORY = originalEnv;
    } else {
      delete process.env.GITHUB_REPOSITORY;
    }
  });

  it("returns items unchanged when repo is invalid", async () => {
    process.env.GITHUB_REPOSITORY = "not-valid";
    const items = [makeItem({ linkedIssueNumber: 5, reactions: 0 })];
    const result = await syncReactionsToItems(items);
    expect(result).toEqual(items);
    expect(mockGithubApiRequest).not.toHaveBeenCalled();
  });

  it("returns items unchanged when no items have linked issues", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const items = [makeItem({ linkedIssueNumber: null })];
    const result = await syncReactionsToItems(items);
    expect(result).toEqual(items);
    expect(mockGithubApiRequest).not.toHaveBeenCalled();
  });

  it("fetches +1 reactions and updates items with linked issues", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    mockGithubApiRequest.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 5, title: "Issue", reactions: { "+1": 7, "-1": 1, total_count: 8 } }),
    } as unknown as Response);

    const items = [
      makeItem({ linkedIssueNumber: 5, reactions: 0 }),
      makeItem({ id: "item-2", linkedIssueNumber: null, reactions: 0 }),
    ];
    const result = await syncReactionsToItems(items);

    expect(result[0].reactions).toBe(7);
    expect(result[1].reactions).toBe(0); // unlinked item unchanged
    expect(mockGithubApiRequest).toHaveBeenCalledWith("GET", "/repos/owner/repo/issues/5");
  });

  it("returns original items when API returns non-ok response", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    mockGithubApiRequest.mockResolvedValueOnce({ ok: false } as Response);

    const items = [makeItem({ linkedIssueNumber: 3, reactions: 0 })];
    const result = await syncReactionsToItems(items);
    expect(result).toEqual(items);
  });

  it("skips issue silently when API call throws", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    mockGithubApiRequest.mockRejectedValueOnce(new Error("network error"));

    const items = [makeItem({ linkedIssueNumber: 9, reactions: 0 })];
    const result = await syncReactionsToItems(items);
    expect(result).toEqual(items);
  });

  it("defaults to 0 reactions when +1 field is missing from response", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    mockGithubApiRequest.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 5, reactions: { total_count: 3 } }), // no "+1" field
    } as unknown as Response);

    const items = [makeItem({ linkedIssueNumber: 5, reactions: 0 })];
    const result = await syncReactionsToItems(items);
    // reactionMap gets 0 — no change from original (0 → 0)
    expect(result[0].reactions).toBe(0);
  });

  it("isolates per-item failures — failed item keeps original reactions, successful item is updated", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    mockGithubApiRequest
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 2, reactions: { "+1": 5 } }),
      } as unknown as Response);

    const items = [
      makeItem({ id: "item-1", linkedIssueNumber: 1, reactions: 3 }),
      makeItem({ id: "item-2", linkedIssueNumber: 2, reactions: 0 }),
    ];
    const result = await syncReactionsToItems(items);

    // failed item keeps its original reactions value
    expect(result[0].reactions).toBe(3);
    // successful item gets updated reactions
    expect(result[1].reactions).toBe(5);
    expect(mockGithubApiRequest).toHaveBeenCalledTimes(2);
  });

  it("handles multiple linked items with individual API calls", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    mockGithubApiRequest
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 1, reactions: { "+1": 3 } }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 2, reactions: { "+1": 10 } }),
      } as unknown as Response);

    const items = [
      makeItem({ id: "item-1", linkedIssueNumber: 1, reactions: 0 }),
      makeItem({ id: "item-2", linkedIssueNumber: 2, reactions: 0 }),
    ];
    const result = await syncReactionsToItems(items);

    expect(result[0].reactions).toBe(3);
    expect(result[1].reactions).toBe(10);
    expect(mockGithubApiRequest).toHaveBeenCalledTimes(2);
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

  it("returns false and logs when githubApiRequest rejects (network error)", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGithubApiRequest.mockRejectedValueOnce(new Error("ECONNRESET"));

    const result = await closeIssueWithComment(7, 1, "Some comment");

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[issues] closeIssueWithComment failed for issue #7"),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("ECONNRESET"));
    errorSpy.mockRestore();
  });

  it("returns false when POST comment succeeds but PATCH state rejects", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // POST comment resolves OK, but PATCH state throws (e.g. network drop mid-flight)
    mockGithubApiRequest.mockResolvedValueOnce({ ok: true } as Response);
    mockGithubApiRequest.mockRejectedValueOnce(new Error("PATCH failed"));

    const result = await closeIssueWithComment(9, 1, "Closing comment");

    expect(result).toBe(false);
    // POST comment was still attempted
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      "POST",
      "/repos/owner/repo/issues/9/comments",
      { body: "Closing comment" },
    );
    // PATCH was attempted too
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      "PATCH",
      "/repos/owner/repo/issues/9",
      { state: "closed" },
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[issues] closeIssueWithComment failed for issue #9"),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("PATCH failed"));
    errorSpy.mockRestore();
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

