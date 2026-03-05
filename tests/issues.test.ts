import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchCommunityIssues } from "../src/issues.js";

describe("fetchCommunityIssues", () => {
  const originalEnv = process.env.GITHUB_REPOSITORY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.GITHUB_REPOSITORY = originalEnv;
    } else {
      delete process.env.GITHUB_REPOSITORY;
    }
  });

  it("returns empty array when no GITHUB_REPOSITORY env", () => {
    delete process.env.GITHUB_REPOSITORY;
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
