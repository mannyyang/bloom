import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync, execFileSync } from "child_process";

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
  BUILD_TIMEOUT_MS,
  GIT_OP_TIMEOUT_MS,
  GIT_PUSH_TIMEOUT_MS,
  GIT_REVERT_TIMEOUT_MS,
} from "../src/lifecycle.js";

describe("lifecycle helpers", () => {
  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExecFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("timeout constants", () => {
    it("exports expected timeout values", () => {
      expect(BUILD_TIMEOUT_MS).toBe(120_000);
      expect(GIT_OP_TIMEOUT_MS).toBe(30_000);
      expect(GIT_PUSH_TIMEOUT_MS).toBe(60_000);
      expect(GIT_REVERT_TIMEOUT_MS).toBe(10_000);
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

    it("returns false when git add fails", () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error("add failed"); });
      expect(commitRoadmap(42)).toBe(false);
    });

    it("returns false when git commit fails", () => {
      mockedExecFileSync
        .mockReturnValueOnce(Buffer.from(""))
        .mockImplementationOnce(() => { throw new Error("nothing to commit"); });
      expect(commitRoadmap(42)).toBe(false);
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
  });

  describe("revertUncommitted", () => {
    it("runs git checkout . and git clean -fd using execFileSync", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      revertUncommitted();
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["checkout", "."],
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

    it("returns false for non-positive integers", () => {
      expect(createSafetyTag(0)).toBe(false);
      expect(createSafetyTag(-1)).toBe(false);
      expect(createSafetyTag(1.5)).toBe(false);
      expect(mockedExecFileSync).not.toHaveBeenCalled();
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

    it("reverts between attempts but not after last attempt", () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("build failed");
      });
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      // All 3 builds fail → hard reset
      const result = runBuildVerification(42, 3);
      expect(result.passed).toBe(false);
      // revertUncommitted runs checkout + clean; count checkout calls
      const checkoutCount = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "checkout"
      ).length;
      expect(checkoutCount).toBe(2);
      // Also verify git clean -fd was called for each revert
      const cleanCount = mockedExecFileSync.mock.calls.filter(
        (args) => args[0] === "git" && Array.isArray(args[1]) && (args[1] as string[])[0] === "clean"
      ).length;
      expect(cleanCount).toBe(2);
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

    it("throws when hard reset fails (manual intervention needed)", () => {
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (String(cmd).includes("pnpm")) throw new Error("build failed");
        return Buffer.from("");
      });
      mockedExecFileSync.mockImplementation(() => { throw new Error("reset failed"); });
      expect(() => runBuildVerification(42, 3)).toThrow();
    });

    it("skips revert and hard-resets immediately when maxAttempts=1", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockedExecSync.mockImplementation(() => { throw new Error("build failed"); });
      mockedExecFileSync.mockReturnValue(Buffer.from(""));

      const result = runBuildVerification(42, 1);

      expect(result.passed).toBe(false);
      // No revert (checkout/clean) since there are no retries with maxAttempts=1
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
  });
});
