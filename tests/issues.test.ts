import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchCommunityIssues, acknowledgeIssues, isValidRepo, isSafeIssueNumber } from "../src/issues.js";
import { githubApiRequest } from "../src/github-app.js";

vi.mock("../src/github-app.js", () => ({
  githubApiRequest: vi.fn(),
}));

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

describe("fetchCommunityIssues", () => {
  const originalEnv = process.env.GITHUB_REPOSITORY;

  afterEach(() => {
    mockGithubApiRequest.mockReset();
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
});

describe("acknowledgeIssues", () => {
  const originalEnv = process.env.GITHUB_REPOSITORY;

  afterEach(() => {
    mockGithubApiRequest.mockReset();
    if (originalEnv !== undefined) {
      process.env.GITHUB_REPOSITORY = originalEnv;
    } else {
      delete process.env.GITHUB_REPOSITORY;
    }
  });

  it("does nothing when the issue list is empty", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    await expect(acknowledgeIssues([], 3)).resolves.toBeUndefined();
  });

  it("does nothing when the repo format is invalid", async () => {
    process.env.GITHUB_REPOSITORY = "not-a-valid-repo";
    const issue = { number: 1, title: "Test", body: "", reactions: 0 };
    await expect(acknowledgeIssues([issue], 3)).resolves.toBeUndefined();
  });

  it("closes an issue that already has a Bloom comment from a prior cycle", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const issue = { number: 7, title: "Old issue", body: "", reactions: 0 };

    // First call: GET comments — returns a prior "Seen by Bloom" comment
    mockGithubApiRequest.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ body: "Seen by Bloom in cycle 5. Thank you for your input!" }],
    } as unknown as Response);
    // Second call: PATCH to close the issue
    mockGithubApiRequest.mockResolvedValueOnce({ ok: true } as Response);

    await acknowledgeIssues([issue], 6);

    // Verify the PATCH call to close the issue
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      "PATCH",
      "/repos/owner/repo/issues/7",
      { state: "closed", state_reason: "completed" },
    );
    // Should NOT have posted a new comment (only 2 calls: GET comments + PATCH close)
    expect(mockGithubApiRequest).toHaveBeenCalledTimes(2);
  });

  it("posts a comment and label for a new issue without prior Bloom comment", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const issue = { number: 10, title: "New issue", body: "", reactions: 0 };

    // First call: GET comments — no Bloom comment found
    mockGithubApiRequest.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ body: "Some other comment" }],
    } as unknown as Response);
    // Second call: POST comment
    mockGithubApiRequest.mockResolvedValueOnce({ ok: true } as Response);
    // Third call: POST label
    mockGithubApiRequest.mockResolvedValueOnce({ ok: true } as Response);

    await acknowledgeIssues([issue], 8);

    // Verify comment was posted
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      "POST",
      "/repos/owner/repo/issues/10/comments",
      { body: "Seen by Bloom in cycle 8. Thank you for your input!" },
    );
    // Verify label was added
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      "POST",
      "/repos/owner/repo/issues/10/labels",
      { labels: ["bloom-reviewed"] },
    );
    expect(mockGithubApiRequest).toHaveBeenCalledTimes(3);
  });

  it("skips issues with unsafe issue numbers without making any API calls", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const issues = [
      { number: NaN, title: "Bad NaN", body: "", reactions: 0 },
      { number: -1, title: "Bad negative", body: "", reactions: 0 },
      { number: 1.5, title: "Bad float", body: "", reactions: 0 },
    ];

    await acknowledgeIssues(issues, 9);

    // No API calls should have been made — all issues have unsafe numbers
    expect(mockGithubApiRequest).not.toHaveBeenCalled();
  });

  it("posts comment when hasBloomComment API returns !res.ok (treats as no prior comment)", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const issue = { number: 15, title: "API error on comments", body: "", reactions: 0 };

    // First call: GET comments returns !ok — hasBloomComment returns false
    mockGithubApiRequest.mockResolvedValueOnce({ ok: false } as Response);
    // Second call: POST comment succeeds
    mockGithubApiRequest.mockResolvedValueOnce({ ok: true } as Response);
    // Third call: POST label succeeds
    mockGithubApiRequest.mockResolvedValueOnce({ ok: true } as Response);

    await acknowledgeIssues([issue], 11);

    // Should have posted a new comment (not closed the issue)
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      "POST",
      "/repos/owner/repo/issues/15/comments",
      { body: "Seen by Bloom in cycle 11. Thank you for your input!" },
    );
    expect(mockGithubApiRequest).toHaveBeenCalledTimes(3);
  });

  it("posts comment when hasBloomComment API throws (treats as no prior comment)", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const issue = { number: 20, title: "Network error on comments", body: "", reactions: 0 };

    // First call: GET comments throws — hasBloomComment returns false
    mockGithubApiRequest.mockRejectedValueOnce(new Error("network down"));
    // Second call: POST comment succeeds
    mockGithubApiRequest.mockResolvedValueOnce({ ok: true } as Response);
    // Third call: POST label succeeds
    mockGithubApiRequest.mockResolvedValueOnce({ ok: true } as Response);

    await acknowledgeIssues([issue], 12);

    // Should have posted a new comment (not closed the issue)
    expect(mockGithubApiRequest).toHaveBeenCalledWith(
      "POST",
      "/repos/owner/repo/issues/20/comments",
      { body: "Seen by Bloom in cycle 12. Thank you for your input!" },
    );
    expect(mockGithubApiRequest).toHaveBeenCalledTimes(3);
  });

  it("completes gracefully when githubApiRequest throws on POST comment", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const issues = [
      { number: 1, title: "Will fail on comment", body: "", reactions: 0 },
      { number: 2, title: "Should still run", body: "", reactions: 0 },
    ];

    // Issue 1: GET comments succeeds (no Bloom comment)
    mockGithubApiRequest.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as unknown as Response);
    // Issue 1: POST comment throws — triggers outer catch block
    mockGithubApiRequest.mockRejectedValueOnce(new Error("boom"));
    // Issue 2: GET comments succeeds (no Bloom comment)
    mockGithubApiRequest.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as unknown as Response);
    // Issue 2: POST comment succeeds
    mockGithubApiRequest.mockResolvedValueOnce({ ok: true } as Response);
    // Issue 2: POST label succeeds
    mockGithubApiRequest.mockResolvedValueOnce({ ok: true } as Response);

    // Should not throw — the outer catch block swallows the error
    await expect(acknowledgeIssues(issues, 10)).resolves.toBeUndefined();

    // Issue 1: 2 calls (GET comments + failed POST), Issue 2: 3 calls
    expect(mockGithubApiRequest).toHaveBeenCalledTimes(5);
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
