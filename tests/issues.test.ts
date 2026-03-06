import { describe, it, expect, afterEach } from "vitest";
import { fetchCommunityIssues, acknowledgeIssues, isValidRepo, isSafeIssueNumber } from "../src/issues.js";

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
