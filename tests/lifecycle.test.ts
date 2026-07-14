import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, execFileSync } from "child_process";
import { ERROR_CATEGORY_NONE } from "../src/errors.js";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);
const mockedExecFileSync = vi.mocked(execFileSync);

import {
  runPreflightCheck,
  setGitBotIdentity,
  commitDb,
  commitRoadmap,
  pushChanges,
  pushTags,
  verifyBuild,
  revertUncommitted,
  hardResetTo,
  isValidGitRef,
  createSafetyTag,
  runBuildVerification,
  safetyTagName,
  parseTimeoutEnv,
  BUILD_TIMEOUT_MS,
  GIT_OP_TIMEOUT_MS,
  GIT_PUSH_TIMEOUT_MS,
  GIT_REVERT_TIMEOUT_MS,
  GIT_BOT_NAME,
  GIT_BOT_EMAIL,
  BUILD_MAX_ATTEMPTS,
  writeCycleSummaryJson,
} from "../src/lifecycle.js";

describe("lifecycle helpers", () => {
  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExecFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("parseTimeoutEnv", () => {
    it("returns defaultMs when envValue is undefined", () => {
      expect(parseTimeoutEnv(undefined, 120_000)).toBe(120_000);
    });

    it("parses a valid positive number string", () => {
      expect(parseTimeoutEnv("180000", 120_000)).toBe(180_000);
    });

    it("rounds a fractional value to the nearest integer", () => {
      expect(parseTimeoutEnv("1500.7", 120_000)).toBe(1501);
    });

    it("falls back to default for NaN (non-numeric string)", () => {
      expect(parseTimeoutEnv("abc", 120_000)).toBe(120_000);
    });

    it("falls back to default for string \"NaN\" (Number(\"NaN\") === NaN gotcha)", () => {
      // Number("NaN") returns NaN, which is non-finite — must fall back to default.
      // This is a common gotcha distinct from a generic non-numeric string.
      expect(parseTimeoutEnv("NaN", 120_000)).toBe(120_000);
    });

    it("falls back to default for empty string", () => {
      expect(parseTimeoutEnv("", 120_000)).toBe(120_000);
    });

    it("falls back to default for zero", () => {
      expect(parseTimeoutEnv("0", 120_000)).toBe(120_000);
    });

    it("falls back to default for negative value", () => {
      expect(parseTimeoutEnv("-1000", 120_000)).toBe(120_000);
    });

    it("falls back to default for a sub-millisecond value that rounds to zero (e.g., 0.4)", () => {
      // parsed = 0.4 > 0 passes the old guard, but Math.round(0.4) = 0 is invalid.
      // The fix checks rounded > 0 after rounding, so 0.4 must fall back.
      expect(parseTimeoutEnv("0.4", 120_000)).toBe(120_000);
    });

    it("falls back to default for Infinity", () => {
      expect(parseTimeoutEnv("Infinity", 120_000)).toBe(120_000);
    });

    it("accepts scientific notation string '1e5' as a valid positive finite (= 100000)", () => {
      // Number("1e5") === 100000 — finite and positive, so it must be accepted.
      // Pins this behaviour so a future regex-based refactor doesn't silently reject it.
      expect(parseTimeoutEnv("1e5", 120_000)).toBe(100_000);
    });
  });

  describe("timeout constants", () => {
    it("exports expected timeout values", () => {
      expect(BUILD_TIMEOUT_MS).toBe(120_000);
      expect(GIT_OP_TIMEOUT_MS).toBe(30_000);
      expect(GIT_PUSH_TIMEOUT_MS).toBe(60_000);
      expect(GIT_REVERT_TIMEOUT_MS).toBe(10_000);
    });
  });

  describe("BUILD_MAX_ATTEMPTS", () => {
    it("is 3", () => {
      expect(BUILD_MAX_ATTEMPTS).toBe(3);
    });
  });

  describe("bot identity constants", () => {
    it("GIT_BOT_NAME equals bloom[bot]", () => {
      expect(GIT_BOT_NAME).toBe("bloom[bot]");
    });

    it("GIT_BOT_EMAIL equals bloom[bot]@users.noreply.github.com", () => {
      expect(GIT_BOT_EMAIL).toBe("bloom[bot]@users.noreply.github.com");
    });
  });

  describe("runPreflightCheck", () => {
    it("returns passed=true with captured output when build+test succeeds", () => {
      mockedExecSync.mockReturnValue("Tests  490 passed\n");
      const result = runPreflightCheck();
      expect(result.passed).toBe(true);
      expect(result.output).toBe("Tests  490 passed\n");
      expect(mockedExecSync).toHaveBeenCalledWith(
        "pnpm build && pnpm test",
        expect.objectContaining({ encoding: "utf-8", timeout: BUILD_TIMEOUT_MS }),
      );
    });

    it("returns passed=false when build+test fails", () => {
      mockedExecSync.mockImplementation(() => { throw new Error("build failed"); });
      const result = runPreflightCheck();
      expect(result.passed).toBe(false);
    });

    it("captures stdout from error object on failure", () => {
      const err = new Error("build failed") as Error & { stdout: string };
      err.stdout = "Tests  100 passed\nsome failure";
      mockedExecSync.mockImplementation(() => { throw err; });
      const result = runPreflightCheck();
      expect(result.passed).toBe(false);
      expect(result.output).toBe("Tests  100 passed\nsome failure");
    });

    it("captures stderr from error object on failure", () => {
      const err = new Error("build failed") as Error & { stderr: string };
      err.stderr = "Error: Cannot find module './missing'";
      mockedExecSync.mockImplementation(() => { throw err; });
      const result = runPreflightCheck();
      expect(result.passed).toBe(false);
      expect(result.output).toContain("Cannot find module './missing'");
    });

    it("combines stdout and stderr from error object on failure", () => {
      const err = new Error("build failed") as Error & { stdout: string; stderr: string };
      err.stdout = "Tests  50 passed\n";
      err.stderr = "FAIL src/foo.test.ts\nAssertionError: expected true";
      mockedExecSync.mockImplementation(() => { throw err; });
      const result = runPreflightCheck();
      expect(result.passed).toBe(false);
      expect(result.output).toContain("Tests  50 passed");
      expect(result.output).toContain("AssertionError: expected true");
    });
  });

  describe("setGitBotIdentity", () => {
    it("sets all four git env vars", () => {
      setGitBotIdentity();
      expect(process.env.GIT_AUTHOR_NAME).toBe("bloom[bot]");
      expect(process.env.GIT_AUTHOR_EMAIL).toBe("bloom[bot]@users.noreply.github.com");
      expect(process.env.GIT_COMMITTER_NAME).toBe("bloom[bot]");
      expect(process.env.GIT_COMMITTER_EMAIL).toBe("bloom[bot]@users.noreply.github.com");
    });

    it("calls execFileSync for git config (no shell interpretation)", () => {
      setGitBotIdentity();
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["config", "user.name", "bloom[bot]"],
        expect.objectContaining({ stdio: "ignore" }),
      );
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["config", "user.email", "bloom[bot]@users.noreply.github.com"],
        expect.objectContaining({ stdio: "ignore" }),
      );
    });

    it("does not throw when git config fails", () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error("git config failed"); });
      expect(() => setGitBotIdentity()).not.toThrow();
    });

    it("emits console.warn when git config fails", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockedExecFileSync.mockImplementation(() => { throw new Error("git config failed"); });
      setGitBotIdentity();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[lifecycle] setGitBotIdentity git config failed (non-fatal)"),
      );
      warnSpy.mockRestore();
    });
  });

  describe("commitDb", () => {
    it("returns true on successful commit", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      expect(commitDb(42)).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["add", "bloom.db"],
        expect.objectContaining({ timeout: GIT_OP_TIMEOUT_MS }),
      );
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["commit", "-m", "cycle 42"],
        expect.objectContaining({ timeout: GIT_OP_TIMEOUT_MS }),
      );
    });

    it("includes label in commit message when provided", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      expect(commitDb(42, "start")).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["commit", "-m", "cycle 42: start"],
        expect.objectContaining({ timeout: GIT_OP_TIMEOUT_MS }),
      );
    });

    it("uses plain cycle message when label is omitted", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      expect(commitDb(42)).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["commit", "-m", "cycle 42"],
        expect.objectContaining({ timeout: GIT_OP_TIMEOUT_MS }),
      );
    });

    it("returns false when git add fails", () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error("add failed"); });
      expect(commitDb(42)).toBe(false);
    });

    it("returns false when git commit fails", () => {
      mockedExecFileSync
        .mockReturnValueOnce(Buffer.from(""))
        .mockImplementationOnce(() => { throw new Error("nothing to commit"); });
      expect(commitDb(42)).toBe(false);
    });

    it("emits console.warn when commitDb fails", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockedExecFileSync.mockImplementation(() => { throw new Error("add failed"); });
      commitDb(42);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[lifecycle] commitDb failed (non-fatal)"),
      );
      warnSpy.mockRestore();
    });

    it("stages bloom-cycle-summary.json when passed as an extraFile", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      expect(commitDb(42, "outcome", ["bloom-cycle-summary.json"])).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["add", "bloom-cycle-summary.json"],
        expect.objectContaining({ timeout: GIT_OP_TIMEOUT_MS }),
      );
    });

    it("stages bloom.db before bloom-cycle-summary.json when extraFiles used", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      commitDb(42, "outcome", ["bloom-cycle-summary.json"]);
      const calls = mockedExecFileSync.mock.calls;
      const addJsonIdx = calls.findIndex(c => Array.isArray(c[1]) && c[1].includes("bloom-cycle-summary.json"));
      // bloom-cycle-summary.json add must be present
      expect(addJsonIdx).toBeGreaterThanOrEqual(0);
      // bloom.db add must appear before bloom-cycle-summary.json add
      const dbIdx = calls.findIndex(c => Array.isArray(c[1]) && c[1].includes("bloom.db") && c[1][0] === "add");
      expect(dbIdx).toBeLessThan(addJsonIdx);
    });

    it("still commits successfully when an extraFile git add fails (non-fatal)", () => {
      mockedExecFileSync
        .mockReturnValueOnce(Buffer.from(""))   // git add bloom.db
        .mockImplementationOnce(() => { throw new Error("file not found"); }) // git add extra (non-fatal)
        .mockReturnValueOnce(Buffer.from(""));  // git commit
      expect(commitDb(42, "outcome", ["bloom-cycle-summary.json"])).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["commit", "-m", "cycle 42: outcome"],
        expect.anything(),
      );
    });

    it("does not call extra git add when extraFiles is undefined", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      commitDb(42, "outcome");
      const addCalls = mockedExecFileSync.mock.calls.filter(
        c => c[0] === "git" && Array.isArray(c[1]) && c[1][0] === "add",
      );
      // Only bloom.db should be staged when no extraFiles are provided
      expect(addCalls).toHaveLength(1);
      expect(addCalls[0][1]).toEqual(["add", "bloom.db"]);
    });
  });

  describe("commitRoadmap", () => {
    it("returns true on successful commit", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      expect(commitRoadmap(42)).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["add", "ROADMAP.md"],
        expect.objectContaining({ timeout: GIT_OP_TIMEOUT_MS }),
      );
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["commit", "-m", "cycle 42: update roadmap"],
        expect.objectContaining({ timeout: GIT_OP_TIMEOUT_MS }),
      );
    });

    it("invokes pnpm generate-pages and stages docs/ on success", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      commitRoadmap(42);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "pnpm",
        ["generate-pages"],
        expect.objectContaining({ timeout: GIT_OP_TIMEOUT_MS }),
      );
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["add", "docs/"],
        expect.objectContaining({ timeout: GIT_OP_TIMEOUT_MS }),
      );
    });

    it("still commits ROADMAP.md when pnpm generate-pages fails (non-fatal)", () => {
      mockedExecFileSync
        .mockReturnValueOnce(Buffer.from(""))          // git add ROADMAP.md
        .mockImplementationOnce(() => { throw new Error("generate-pages not found"); }) // pnpm generate-pages (non-fatal)
        .mockReturnValue(Buffer.from(""));             // git commit and any other calls
      expect(commitRoadmap(42)).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["commit", "-m", "cycle 42: update roadmap"],
        expect.anything(),
      );
    });

    it("emits console.warn when pnpm generate-pages fails (inner catch)", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockedExecFileSync
        .mockReturnValueOnce(Buffer.from(""))          // git add ROADMAP.md
        .mockImplementationOnce(() => { throw new Error("generate-pages not found"); }) // pnpm generate-pages (non-fatal)
        .mockReturnValue(Buffer.from(""));             // git commit
      commitRoadmap(42);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[lifecycle] commitRoadmap generate-pages failed (non-fatal)"),
      );
      warnSpy.mockRestore();
    });

    it("returns false when git add fails", () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error("add failed"); });
      expect(commitRoadmap(42)).toBe(false);
    });

    it("returns false when git commit fails", () => {
      mockedExecFileSync
        .mockReturnValueOnce(Buffer.from(""))  // git add ROADMAP.md
        .mockReturnValueOnce(Buffer.from(""))  // pnpm generate-pages
        .mockReturnValueOnce(Buffer.from(""))  // git add docs/
        .mockImplementationOnce(() => { throw new Error("nothing to commit"); }); // git commit
      expect(commitRoadmap(42)).toBe(false);
    });

    it("emits console.warn when commitRoadmap outer catch fires", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockedExecFileSync.mockImplementation(() => { throw new Error("add failed"); });
      commitRoadmap(42);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[lifecycle] commitRoadmap failed (non-fatal)"),
      );
      warnSpy.mockRestore();
    });

    it("returns true when generate-pages succeeds but git add docs/ throws (inner catch)", () => {
      mockedExecFileSync
        .mockReturnValueOnce(Buffer.from(""))          // git add ROADMAP.md
        .mockReturnValueOnce(Buffer.from(""))          // pnpm generate-pages (succeeds)
        .mockImplementationOnce(() => { throw new Error("git add docs/ failed"); }) // git add docs/ (non-fatal)
        .mockReturnValue(Buffer.from(""));             // git commit
      expect(commitRoadmap(42)).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["commit", "-m", "cycle 42: update roadmap"],
        expect.anything(),
      );
    });
  });

  describe("pushChanges", () => {
    it("returns true on successful push", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      expect(pushChanges()).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["push", "origin", "main"],
        expect.objectContaining({ timeout: GIT_PUSH_TIMEOUT_MS }),
      );
    });

    it("returns false when push fails", () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error("push rejected"); });
      expect(pushChanges()).toBe(false);
    });

    it("emits console.warn when pushChanges fails", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockedExecFileSync.mockImplementation(() => { throw new Error("push rejected"); });
      pushChanges();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[lifecycle] pushChanges failed (non-fatal)"),
      );
      warnSpy.mockRestore();
    });

    it("reads BLOOM_GIT_PUSH_TIMEOUT_MS lazily at call time", () => {
      const prev = process.env.BLOOM_GIT_PUSH_TIMEOUT_MS;
      try {
        process.env.BLOOM_GIT_PUSH_TIMEOUT_MS = "99999";
        mockedExecFileSync.mockReturnValue(Buffer.from(""));
        expect(pushChanges()).toBe(true);
        expect(mockedExecFileSync).toHaveBeenCalledWith(
          "git",
          ["push", "origin", "main"],
          expect.objectContaining({ timeout: 99999 }),
        );
      } finally {
        if (prev === undefined) delete process.env.BLOOM_GIT_PUSH_TIMEOUT_MS;
        else process.env.BLOOM_GIT_PUSH_TIMEOUT_MS = prev;
      }
    });
  });

  describe("pushTags", () => {
    it("returns true on successful tag push", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      expect(pushTags()).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["push", "--tags"],
        expect.objectContaining({ timeout: GIT_PUSH_TIMEOUT_MS }),
      );
    });

    it("returns false when tag push fails", () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error("push rejected"); });
      expect(pushTags()).toBe(false);
    });

    it("emits console.warn when pushTags fails", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockedExecFileSync.mockImplementation(() => { throw new Error("push rejected"); });
      pushTags();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[lifecycle] pushTags failed (non-fatal)"),
      );
      warnSpy.mockRestore();
    });

    it("reads BLOOM_GIT_PUSH_TIMEOUT_MS lazily at call time", () => {
      const prev = process.env.BLOOM_GIT_PUSH_TIMEOUT_MS;
      try {
        process.env.BLOOM_GIT_PUSH_TIMEOUT_MS = "99999";
        mockedExecFileSync.mockReturnValue(Buffer.from(""));
        expect(pushTags()).toBe(true);
        expect(mockedExecFileSync).toHaveBeenCalledWith(
          "git",
          ["push", "--tags"],
          expect.objectContaining({ timeout: 99999 }),
        );
      } finally {
        if (prev === undefined) delete process.env.BLOOM_GIT_PUSH_TIMEOUT_MS;
        else process.env.BLOOM_GIT_PUSH_TIMEOUT_MS = prev;
      }
    });
  });

  describe("verifyBuild", () => {
    it("returns passed=true with captured output when build+test succeeds", () => {
      mockedExecSync.mockReturnValue("Tests  522 passed\n");
      const result = verifyBuild();
      expect(result.passed).toBe(true);
      expect(result.output).toBe("Tests  522 passed\n");
      expect(mockedExecSync).toHaveBeenCalledWith(
        "pnpm build && pnpm test",
        expect.objectContaining({ encoding: "utf-8", timeout: BUILD_TIMEOUT_MS }),
      );
    });

    it("returns passed=false when build+test fails", () => {
      mockedExecSync.mockImplementation(() => { throw new Error("test failed"); });
      const result = verifyBuild();
      expect(result.passed).toBe(false);
    });

    it("captures stdout from error object on failure", () => {
      const err = new Error("test failure") as Error & { stdout: string };
      err.stdout = "Tests  50 passed\nTests  3 failed";
      mockedExecSync.mockImplementation(() => { throw err; });
      const result = verifyBuild();
      expect(result.passed).toBe(false);
      expect(result.output).toContain("Tests  50 passed");
    });

    it("captures stderr from error object on failure", () => {
      const err = new Error("type error") as Error & { stderr: string };
      err.stderr = "TypeError: Cannot read properties of undefined";
      mockedExecSync.mockImplementation(() => { throw err; });
      const result = verifyBuild();
      expect(result.passed).toBe(false);
      expect(result.output).toContain("TypeError: Cannot read properties");
    });

    it("combines stdout and stderr from error object on failure", () => {
      const err = new Error("build failure") as Error & { stdout: string; stderr: string };
      err.stdout = "Tests  10 passed\n";
      err.stderr = "FAIL src/lifecycle.test.ts\nAssertionError: expected false";
      mockedExecSync.mockImplementation(() => { throw err; });
      const result = verifyBuild();
      expect(result.passed).toBe(false);
      expect(result.output).toContain("Tests  10 passed");
      expect(result.output).toContain("AssertionError: expected false");
    });
  });

  describe("revertUncommitted", () => {
    it("runs git checkout -- . and git clean -fd using execFileSync", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      revertUncommitted();
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["checkout", "--", "."],
        expect.objectContaining({ timeout: GIT_REVERT_TIMEOUT_MS }),
      );
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["clean", "-fd"],
        expect.objectContaining({ timeout: GIT_REVERT_TIMEOUT_MS }),
      );
    });

    it("does not throw when git checkout fails", () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error("checkout failed"); });
      expect(() => revertUncommitted()).not.toThrow();
    });

    it("still runs git clean even when git checkout fails", () => {
      let callCount = 0;
      mockedExecFileSync.mockImplementation((..._args: unknown[]) => {
        callCount++;
        if (callCount === 1) throw new Error("checkout failed");
        return Buffer.from("");
      });
      revertUncommitted();
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["clean", "-fd"],
        expect.objectContaining({ timeout: GIT_REVERT_TIMEOUT_MS }),
      );
    });

    it("emits console.warn when git checkout fails", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error("checkout failed"); })
        .mockReturnValue(Buffer.from(""));
      revertUncommitted();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[lifecycle] revertUncommitted checkout failed (non-fatal)"),
      );
      warnSpy.mockRestore();
    });

    it("emits console.warn when git clean fails", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockedExecFileSync
        .mockReturnValueOnce(Buffer.from(""))          // git checkout succeeds
        .mockImplementationOnce(() => { throw new Error("clean failed"); }); // git clean fails
      revertUncommitted();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[lifecycle] revertUncommitted clean failed (non-fatal)"),
      );
      warnSpy.mockRestore();
    });
  });

  describe("createSafetyTag", () => {
    it("creates a tag using execFileSync for a valid cycle count", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      expect(createSafetyTag(42)).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["tag", "-f", "pre-evolution-cycle-42"],
        expect.objectContaining({ timeout: GIT_OP_TIMEOUT_MS }),
      );
    });

    it("returns false when git tag fails", () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error("tag failed"); });
      expect(createSafetyTag(42)).toBe(false);
    });

    it("emits console.warn when createSafetyTag fails", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockedExecFileSync.mockImplementation(() => { throw new Error("tag failed"); });
      createSafetyTag(42);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[lifecycle] createSafetyTag failed (non-fatal)"),
      );
      warnSpy.mockRestore();
    });

    it("returns false for non-positive integers, floats, NaN, and Infinity", () => {
      expect(createSafetyTag(0)).toBe(false);
      expect(createSafetyTag(-1)).toBe(false);
      expect(createSafetyTag(1.5)).toBe(false);
      expect(createSafetyTag(NaN)).toBe(false);
      expect(createSafetyTag(Infinity)).toBe(false);
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe("safetyTagName", () => {
    it("produces the expected tag format string", () => {
      expect(safetyTagName(42)).toBe("pre-evolution-cycle-42");
    });

    it("uses the cycle number as the numeric suffix", () => {
      expect(safetyTagName(1)).toBe("pre-evolution-cycle-1");
      expect(safetyTagName(999)).toBe("pre-evolution-cycle-999");
    });

    it("produces a ref accepted by isValidGitRef", () => {
      expect(isValidGitRef(safetyTagName(42))).toBe(true);
    });
  });

  describe("isValidGitRef", () => {
    it("accepts valid refs", () => {
      expect(isValidGitRef("main")).toBe(true);
      expect(isValidGitRef("pre-evolution-cycle-42")).toBe(true);
      expect(isValidGitRef("v1.0.0")).toBe(true);
      expect(isValidGitRef("origin/main")).toBe(true);
      expect(isValidGitRef("HEAD")).toBe(true);
    });

    it("rejects refs with shell metacharacters", () => {
      expect(isValidGitRef("; rm -rf /")).toBe(false);
      expect(isValidGitRef("ref$(cmd)")).toBe(false);
      expect(isValidGitRef("ref`cmd`")).toBe(false);
      expect(isValidGitRef("ref | cat")).toBe(false);
      expect(isValidGitRef("")).toBe(false);
    });
  });

  describe("hardResetTo", () => {
    it("calls execFileSync with correct args for valid ref", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      hardResetTo("pre-evolution-cycle-42");
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["reset", "--hard", "pre-evolution-cycle-42"],
        expect.objectContaining({ timeout: GIT_REVERT_TIMEOUT_MS }),
      );
    });

    it("throws on invalid ref with shell metacharacters", () => {
      expect(() => hardResetTo("; rm -rf /")).toThrow("Invalid git ref");
    });

    it("throws on empty ref", () => {
      expect(() => hardResetTo("")).toThrow("Invalid git ref");
    });
  });

  describe("runBuildVerification", () => {
    it("returns passed=true when build passes on first attempt", () => {
      mockedExecSync.mockReturnValue("Tests  522 passed\n");
      const result = runBuildVerification(42);
      expect(result.passed).toBe(true);
      expect(result.output).toBe("Tests  522 passed\n");
      // verifyBuild called once, revertUncommitted not called
      expect(mockedExecSync).toHaveBeenCalledTimes(1);
    });

    it("retries and returns passed=true when build passes on second attempt", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockedExecSync
        .mockImplementationOnce(() => { throw new Error("build failed"); }) // attempt 1: verifyBuild fails
        .mockReturnValueOnce("Tests  522 passed\n"); // attempt 2: verifyBuild passes
      mockedExecFileSync.mockReturnValue(Buffer.from("")); // revertUncommitted uses execFileSync
      const result = runBuildVerification(42);
      expect(result.passed).toBe(true);
      expect(result.output).toBe("Tests  522 passed\n");
      expect(errorSpy).toHaveBeenCalledWith("Build verification failed (attempt 1/3)");
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it("reverts between failed attempts but not before the final hard reset", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockedExecSync.mockImplementation(() => {
        throw new Error("build failed");
      });
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      // All 3 builds fail → hard reset
      const result = runBuildVerification(42, 3);
      expect(result.passed).toBe(false);
      // revertUncommitted runs checkout + clean only between attempts (not before hard reset)
      const checkoutCount = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "checkout"
      ).length;
      expect(checkoutCount).toBe(2);
      // Also verify git clean -fd was called for each revert
      const cleanCount = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "clean"
      ).length;
      expect(cleanCount).toBe(2);
      expect(errorSpy).toHaveBeenCalledWith("Build verification failed (attempt 1/3)");
      expect(errorSpy).toHaveBeenCalledWith("Build broken after all attempts. Reverting to pre-evolution state.");
      errorSpy.mockRestore();
    });

    it("hard resets and returns passed=false when all attempts fail", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (String(cmd).includes("pnpm")) throw new Error("build failed");
        return Buffer.from("");
      });
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      const result = runBuildVerification(42, 3);
      expect(result.passed).toBe(false);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["reset", "--hard", "pre-evolution-cycle-42"],
        expect.objectContaining({ timeout: GIT_REVERT_TIMEOUT_MS }),
      );
      expect(errorSpy).toHaveBeenCalledWith("Build verification failed (attempt 1/3)");
      expect(errorSpy).toHaveBeenCalledWith("Build verification failed (attempt 2/3)");
      expect(errorSpy).toHaveBeenCalledWith("Build verification failed (attempt 3/3)");
      expect(errorSpy).toHaveBeenCalledWith("Build broken after all attempts. Reverting to pre-evolution state.");
    });

    it("logs last captured build output before hard-resetting when all attempts fail", () => {
      // Verifies that the last build's stderr/stdout is emitted via console.error
      // immediately before hardResetTo so engineers can diagnose CI failures.
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const buildOutput = "Tests  5 failed\nTypeError: Cannot read property 'x' of undefined";
      const buildErr = new Error("build failed") as Error & { stdout: string };
      buildErr.stdout = buildOutput;
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (String(cmd).includes("pnpm")) throw buildErr;
        return Buffer.from("");
      });
      mockedExecFileSync.mockReturnValue(Buffer.from(""));

      runBuildVerification(42, 2);

      // The captured output must be logged before the hard-reset message
      const calls = errorSpy.mock.calls.map(c => c[0] as string);
      const outputCallIdx = calls.indexOf(buildOutput);
      const hardResetMsgIdx = calls.indexOf("Build broken after all attempts. Reverting to pre-evolution state.");

      expect(outputCallIdx).toBeGreaterThan(-1); // output was logged
      // Output logged AFTER the "Build broken" message and BEFORE hardResetTo runs
      expect(outputCallIdx).toBeGreaterThan(hardResetMsgIdx);

      errorSpy.mockRestore();
    });

    it("throws when hard reset fails (manual intervention needed)", () => {
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (String(cmd).includes("pnpm")) throw new Error("build failed");
        return Buffer.from("");
      });
      mockedExecFileSync.mockImplementation(() => { throw new Error("reset failed"); });
      expect(() => runBuildVerification(42, 3)).toThrow();
    });

    it("returns passed=false immediately without calling verifyBuild or hardResetTo when maxAttempts=0", () => {
      const result = runBuildVerification(42, 0);
      expect(result.passed).toBe(false);
      expect(result.output).toBe("");
      // No build attempted, no reset performed
      expect(mockedExecSync).not.toHaveBeenCalled();
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it("returns passed=false immediately without calling verifyBuild or hardResetTo when maxAttempts is negative", () => {
      const resultNeg1 = runBuildVerification(42, -1);
      expect(resultNeg1.passed).toBe(false);
      expect(resultNeg1.output).toBe("");
      expect(mockedExecSync).not.toHaveBeenCalled();
      expect(mockedExecFileSync).not.toHaveBeenCalled();

      const resultNeg5 = runBuildVerification(42, -5);
      expect(resultNeg5.passed).toBe(false);
      expect(resultNeg5.output).toBe("");
      expect(mockedExecSync).not.toHaveBeenCalled();
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it("skips revert and goes straight to hard-reset when maxAttempts=1", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockedExecSync.mockImplementation(() => { throw new Error("build failed"); });
      mockedExecFileSync.mockReturnValue(Buffer.from(""));

      const result = runBuildVerification(42, 1);

      expect(result.passed).toBe(false);
      // revertUncommitted is NOT called when the only attempt is the final attempt
      const checkoutCount = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "checkout",
      ).length;
      expect(checkoutCount).toBe(0);
      const cleanCount = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "clean",
      ).length;
      expect(cleanCount).toBe(0);
      // Hard reset IS still called after the single failed attempt
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["reset", "--hard", "pre-evolution-cycle-42"],
        expect.objectContaining({ timeout: GIT_REVERT_TIMEOUT_MS }),
      );
      errorSpy.mockRestore();
    });

    it("returns passed=true and calls revertUncommitted exactly once when maxAttempts=2 and 2nd attempt succeeds", () => {
      // Boundary case: maxAttempts=2, attempt 1 fails, attempt 2 passes.
      // revertUncommitted must be called exactly once (between attempts 1 and 2),
      // verifyBuild must be called exactly twice (two execSync calls),
      // hardResetTo must never be called (no reset needed when a retry succeeds),
      // and the function must return passed=true.
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockedExecSync
        .mockImplementationOnce(() => { throw new Error("attempt 1 failed"); })
        .mockReturnValueOnce("Tests  522 passed\n");
      mockedExecFileSync.mockReturnValue(Buffer.from(""));

      const result = runBuildVerification(42, 2);
      expect(result.passed).toBe(true);
      expect(result.output).toBe("Tests  522 passed\n");

      // verifyBuild uses execSync — exactly two calls (one fail, one pass)
      expect(mockedExecSync).toHaveBeenCalledTimes(2);

      // revertUncommitted uses git checkout + git clean; each called exactly once
      const checkoutCalls = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "checkout",
      );
      expect(checkoutCalls).toHaveLength(1);

      const cleanCalls = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "clean",
      );
      expect(cleanCalls).toHaveLength(1);

      // hardResetTo must NOT be called when a retry eventually passes
      const resetCalls = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "reset",
      );
      expect(resetCalls).toHaveLength(0);

      // Error logged for attempt 1 failure with correct attempt/maxAttempts label
      expect(errorSpy).toHaveBeenCalledWith("Build verification failed (attempt 1/2)");
      expect(errorSpy).toHaveBeenCalledTimes(1);

      errorSpy.mockRestore();
    });

    it("calls revertUncommitted exactly once and hard-resets when maxAttempts=2 and both attempts fail", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockedExecSync.mockImplementation(() => { throw new Error("build failed"); });
      mockedExecFileSync.mockReturnValue(Buffer.from(""));

      const result = runBuildVerification(42, 2);

      expect(result.passed).toBe(false);
      // revertUncommitted is called once (between attempt 1 and 2, NOT before hard reset)
      const checkoutCount = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "checkout",
      ).length;
      expect(checkoutCount).toBe(1);
      const cleanCount = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "clean",
      ).length;
      expect(cleanCount).toBe(1);
      // Hard reset IS called after both attempts fail
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["reset", "--hard", "pre-evolution-cycle-42"],
        expect.objectContaining({ timeout: GIT_REVERT_TIMEOUT_MS }),
      );
      expect(errorSpy).toHaveBeenCalledWith("Build verification failed (attempt 1/2)");
      expect(errorSpy).toHaveBeenCalledWith("Build verification failed (attempt 2/2)");
      expect(errorSpy).toHaveBeenCalledWith("Build broken after all attempts. Reverting to pre-evolution state.");
      errorSpy.mockRestore();
    });

    it("respects custom maxAttempts parameter", () => {
      let buildCallCount = 0;
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (String(cmd).includes("pnpm")) {
          buildCallCount++;
          throw new Error("build failed");
        }
        return Buffer.from("");
      });
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      runBuildVerification(42, 5);
      expect(buildCallCount).toBe(5);
    });

    it("calls revertUncommitted exactly once when second attempt succeeds", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockedExecSync
        .mockImplementationOnce(() => { throw new Error("attempt 1 failed"); })
        .mockReturnValueOnce("Tests  522 passed\n");
      mockedExecFileSync.mockReturnValue(Buffer.from(""));

      const result = runBuildVerification(42);
      expect(result.passed).toBe(true);

      // revertUncommitted uses git checkout + git clean; each should be called exactly once
      const checkoutCalls = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "checkout",
      );
      expect(checkoutCalls).toHaveLength(1);

      const cleanCalls = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "clean",
      );
      expect(cleanCalls).toHaveLength(1);

      errorSpy.mockRestore();
    });

    it("does not call hardResetTo when a retry attempt eventually passes", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockedExecSync
        .mockImplementationOnce(() => { throw new Error("attempt 1 failed"); })
        .mockReturnValueOnce("Tests  522 passed\n");
      mockedExecFileSync.mockReturnValue(Buffer.from(""));

      const result = runBuildVerification(42);
      expect(result.passed).toBe(true);

      // hardResetTo calls git reset --hard — it must NOT be called when a retry succeeds
      const resetCalls = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "reset",
      );
      expect(resetCalls).toHaveLength(0);

      errorSpy.mockRestore();
    });

    it("returns passed=true when build passes on third attempt after two failures", () => {
      // Covers the intermediate path: attempts 1 and 2 fail, attempt 3 succeeds.
      // Verifies that revertUncommitted is called exactly twice (once per failed attempt)
      // and hardResetTo is never called.
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockedExecSync
        .mockImplementationOnce(() => { throw new Error("attempt 1 failed"); })
        .mockImplementationOnce(() => { throw new Error("attempt 2 failed"); })
        .mockReturnValueOnce("Tests  530 passed\n");
      mockedExecFileSync.mockReturnValue(Buffer.from(""));

      const result = runBuildVerification(42);
      expect(result.passed).toBe(true);
      expect(result.output).toBe("Tests  530 passed\n");

      // revertUncommitted (checkout + clean) called twice — once per failed attempt
      const checkoutCalls = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "checkout",
      );
      expect(checkoutCalls).toHaveLength(2);

      const cleanCalls = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "clean",
      );
      expect(cleanCalls).toHaveLength(2);

      // hardResetTo must NOT be called when a retry eventually succeeds
      const resetCalls = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "reset",
      );
      expect(resetCalls).toHaveLength(0);

      expect(errorSpy).toHaveBeenCalledWith("Build verification failed (attempt 1/3)");
      expect(errorSpy).toHaveBeenCalledWith("Build verification failed (attempt 2/3)");
      expect(errorSpy).toHaveBeenCalledTimes(2);

      errorSpy.mockRestore();
    });
  });

  describe("lazy timeout evaluation via process.env", () => {
    const envKeys = [
      "BLOOM_BUILD_TIMEOUT_MS",
      "BLOOM_GIT_OP_TIMEOUT_MS",
      "BLOOM_GIT_PUSH_TIMEOUT_MS",
      "BLOOM_GIT_REVERT_TIMEOUT_MS",
    ] as const;

    afterEach(() => {
      for (const key of envKeys) delete process.env[key];
    });

    it("runPreflightCheck uses BLOOM_BUILD_TIMEOUT_MS when set", () => {
      process.env.BLOOM_BUILD_TIMEOUT_MS = "5000";
      mockedExecSync.mockReturnValue("ok");
      runPreflightCheck();
      expect(mockedExecSync).toHaveBeenCalledWith(
        "pnpm build && pnpm test",
        expect.objectContaining({ timeout: 5000 }),
      );
    });

    it("runPreflightCheck falls back to 120_000 when BLOOM_BUILD_TIMEOUT_MS is absent", () => {
      delete process.env.BLOOM_BUILD_TIMEOUT_MS;
      mockedExecSync.mockReturnValue("ok");
      runPreflightCheck();
      expect(mockedExecSync).toHaveBeenCalledWith(
        "pnpm build && pnpm test",
        expect.objectContaining({ timeout: 120_000 }),
      );
    });

    it("commitDb uses BLOOM_GIT_OP_TIMEOUT_MS when set", () => {
      process.env.BLOOM_GIT_OP_TIMEOUT_MS = "8000";
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      commitDb(1);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["add", "bloom.db"],
        expect.objectContaining({ timeout: 8000 }),
      );
    });

    it("pushChanges uses BLOOM_GIT_PUSH_TIMEOUT_MS when set", () => {
      process.env.BLOOM_GIT_PUSH_TIMEOUT_MS = "12000";
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      pushChanges();
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["push", "origin", "main"],
        expect.objectContaining({ timeout: 12000 }),
      );
    });

    it("revertUncommitted uses BLOOM_GIT_REVERT_TIMEOUT_MS when set", () => {
      process.env.BLOOM_GIT_REVERT_TIMEOUT_MS = "3000";
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      revertUncommitted();
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["checkout", "--", "."],
        expect.objectContaining({ timeout: 3000 }),
      );
    });

    it("pushTags uses BLOOM_GIT_PUSH_TIMEOUT_MS when set", () => {
      process.env.BLOOM_GIT_PUSH_TIMEOUT_MS = "15000";
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      pushTags();
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["push", "--tags"],
        expect.objectContaining({ timeout: 15000 }),
      );
    });

    it("verifyBuild uses BLOOM_BUILD_TIMEOUT_MS when set", () => {
      process.env.BLOOM_BUILD_TIMEOUT_MS = "7000";
      mockedExecSync.mockReturnValue("ok");
      verifyBuild();
      expect(mockedExecSync).toHaveBeenCalledWith(
        "pnpm build && pnpm test",
        expect.objectContaining({ timeout: 7000 }),
      );
    });

    it("commitRoadmap uses BLOOM_GIT_OP_TIMEOUT_MS when set", () => {
      process.env.BLOOM_GIT_OP_TIMEOUT_MS = "9000";
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      commitRoadmap(1);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["add", "ROADMAP.md"],
        expect.objectContaining({ timeout: 9000 }),
      );
    });

    it("createSafetyTag uses BLOOM_GIT_OP_TIMEOUT_MS when set", () => {
      process.env.BLOOM_GIT_OP_TIMEOUT_MS = "6000";
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      createSafetyTag(1);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["tag", "-f", "pre-evolution-cycle-1"],
        expect.objectContaining({ timeout: 6000 }),
      );
    });

    it("hardResetTo uses BLOOM_GIT_REVERT_TIMEOUT_MS when set", () => {
      process.env.BLOOM_GIT_REVERT_TIMEOUT_MS = "4000";
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      hardResetTo("pre-evolution-cycle-1");
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["reset", "--hard", "pre-evolution-cycle-1"],
        expect.objectContaining({ timeout: 4000 }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// writeCycleSummaryJson
// ---------------------------------------------------------------------------

describe("writeCycleSummaryJson", () => {
  let destPath: string;

  const makeOutcome = (overrides: Partial<{
    cycleNumber: number; buildVerificationPassed: boolean; pushSucceeded: boolean;
    improvementsAttempted: number; improvementsSucceeded: number; durationMs: number | null;
  }> = {}) => ({
    cycleNumber: 1,
    preflightPassed: true,
    improvementsAttempted: 2,
    improvementsSucceeded: 1,
    buildVerificationPassed: true,
    pushSucceeded: true,
    testCountBefore: null,
    testCountAfter: null,
    testTotalBefore: null,
    testTotalAfter: null,
    durationMs: 60000,
    failureCategory: ERROR_CATEGORY_NONE,
    ...overrides,
  });

  beforeEach(() => {
    destPath = join(tmpdir(), `bloom-cycle-summary-test-${process.pid}-${Date.now()}.json`);
  });

  afterEach(() => {
    for (const path of [destPath, `${destPath}.tmp`]) {
      try { if (existsSync(path)) unlinkSync(path); } catch { /* ignore */ }
    }
  });

  it("writes a valid JSON file to the destination path", () => {
    writeCycleSummaryJson(makeOutcome(), destPath);
    expect(existsSync(destPath)).toBe(true);
    const content = readFileSync(destPath, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("written JSON contains expected top-level fields", () => {
    writeCycleSummaryJson(makeOutcome({ cycleNumber: 42 }), destPath);
    const parsed = JSON.parse(readFileSync(destPath, "utf-8"));
    expect(parsed.cycleNumber).toBe(42);
    expect(typeof parsed.buildPassed).toBe("boolean");
    expect(typeof parsed.pushed).toBe("boolean");
    expect(typeof parsed.improvementsAttempted).toBe("number");
    expect(typeof parsed.improvementsSucceeded).toBe("number");
    expect(typeof parsed.failureCategory).toBe("string");
    expect(typeof parsed.generatedAt).toBe("string");
  });

  it("reflects buildPassed and pushed from outcome", () => {
    writeCycleSummaryJson(
      makeOutcome({ buildVerificationPassed: false, pushSucceeded: false }),
      destPath,
    );
    const parsed = JSON.parse(readFileSync(destPath, "utf-8"));
    expect(parsed.buildPassed).toBe(false);
    expect(parsed.pushed).toBe(false);
  });

  it("durationMs is included as null when outcome.durationMs is null", () => {
    writeCycleSummaryJson(makeOutcome({ durationMs: null }), destPath);
    const parsed = JSON.parse(readFileSync(destPath, "utf-8"));
    expect(parsed.durationMs).toBeNull();
  });

  it("temp file is cleaned up after successful write (no .tmp file left)", () => {
    writeCycleSummaryJson(makeOutcome(), destPath);
    expect(existsSync(`${destPath}.tmp`)).toBe(false);
  });

  it("logs a warning, does not throw, and cleans up .tmp when renameSync fails", () => {
    // Force renameSync to fail by pre-creating a directory at destPath.
    // writeFileSync(tmpPath) succeeds (tmpPath is destPath + ".tmp", a sibling file),
    // but renameSync(tmpPath, destPath) fails with EISDIR because destPath is a directory.
    const { mkdirSync, rmdirSync } = require("node:fs");
    mkdirSync(destPath, { recursive: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => writeCycleSummaryJson(makeOutcome(), destPath)).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("writeCycleSummaryJson failed"));
      // Temp file must be cleaned up even though rename failed
      expect(existsSync(`${destPath}.tmp`)).toBe(false);
    } finally {
      warnSpy.mockRestore();
      try { rmdirSync(destPath); } catch { /* ignore */ }
    }
  });
});
