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
    if (originalEnv !== undefined) {
      process.env.GITHUB_REPOSITORY = originalEnv;
    } else {
      delete process.env.GITHUB_REPOSITORY;
    }
  });

  it("returns empty array when repo format is invalid", () => {
    process.env.GITHUB_REPOSITORY = "not-a-valid-repo";
    const result = fetchCommunityIssues();
    expect(result).toEqual([]);
  });

  it("returns empty array when gh command fails", () => {
    process.env.GITHUB_REPOSITORY = "nonexistent/repo";
    const result = fetchCommunityIssues();
    expect(result).toEqual([]);
  });

  it("returns empty array for malicious repo containing shell metacharacters", () => {
    process.env.GITHUB_REPOSITORY = "foo/bar; rm -rf ~";
    const result = fetchCommunityIssues();
    expect(result).toEqual([]);
  });

  it("returns empty array for repo with backtick injection attempt", () => {
    process.env.GITHUB_REPOSITORY = "foo/`whoami`";
    const result = fetchCommunityIssues();
    expect(result).toEqual([]);
  });
});

describe("acknowledgeIssues", () => {
  const originalEnv = process.env.GITHUB_REPOSITORY;

  afterEach(() => {
    mockGithubApiRequest.mockReset();
  });

  afterEach(() => {
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
