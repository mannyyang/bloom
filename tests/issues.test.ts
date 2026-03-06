import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchCommunityIssues, acknowledgeIssues, hasBloomComment, labelIssue } from "../src/issues.js";

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
    if (originalEnv !== undefined) {
      process.env.GITHUB_REPOSITORY = originalEnv;
    } else {
      delete process.env.GITHUB_REPOSITORY;
    }
  });

  it("does nothing when the issue list is empty", () => {
    // Should not throw regardless of repo config.
    process.env.GITHUB_REPOSITORY = "owner/repo";
    expect(() => acknowledgeIssues([], 3)).not.toThrow();
  });

  it("does nothing when the repo format is invalid", () => {
    process.env.GITHUB_REPOSITORY = "not-a-valid-repo";
    const issue = { number: 1, title: "Test", body: "", reactions: 0 };
    expect(() => acknowledgeIssues([issue], 3)).not.toThrow();
  });

  it("does nothing when no repo is detectable", () => {
    delete process.env.GITHUB_REPOSITORY;
    const issue = { number: 1, title: "Test", body: "", reactions: 0 };
    // detectRepo() falls back to git remote get-url, which may fail in CI.
    // Either way, acknowledgeIssues must not throw.
    expect(() => acknowledgeIssues([issue], 3)).not.toThrow();
  });

  it("swallows gh command failure gracefully", () => {
    // The repo format is valid but nonexistent — gh will fail; must not throw.
    process.env.GITHUB_REPOSITORY = "nonexistent/repo";
    const issue = { number: 42, title: "Feature request", body: "", reactions: 5 };
    expect(() => acknowledgeIssues([issue], 3)).not.toThrow();
  });
});

describe("labelIssue", () => {
  it("does nothing for invalid repo format", () => {
    expect(() => labelIssue(1, "not-valid", "bloom-reviewed")).not.toThrow();
  });

  it("does nothing for label with shell metacharacters", () => {
    expect(() => labelIssue(1, "owner/repo", "bad;label")).not.toThrow();
  });

  it("swallows gh failure gracefully for nonexistent repo", () => {
    expect(() => labelIssue(42, "nonexistent/repo", "bloom-reviewed")).not.toThrow();
  });
});

describe("hasBloomComment", () => {
  it("returns false when gh command fails (nonexistent repo)", () => {
    // gh will fail for a nonexistent repo; should return false, not throw.
    const result = hasBloomComment(1, "nonexistent/repo");
    expect(result).toBe(false);
  });

  it("returns false for invalid repo format", () => {
    // Even if called with bad input, should not throw.
    const result = hasBloomComment(1, "not-valid");
    expect(result).toBe(false);
  });
});
