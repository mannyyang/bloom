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
  commitCycleCount,
  pushChanges,
  pushTags,
  verifyBuild,
  revertUncommitted,
  hardResetTo,
  isValidGitRef,
  createSafetyTag,
  runBuildVerification,
} from "../src/lifecycle.js";

describe("lifecycle helpers", () => {
  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExecFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runPreflightCheck", () => {
    it("returns true when build+test succeeds", () => {
      mockedExecSync.mockReturnValue(Buffer.from(""));
      expect(runPreflightCheck()).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        "pnpm build && pnpm test",
        expect.objectContaining({ timeout: 120_000 }),
      );
    });

    it("returns false when build+test fails", () => {
      mockedExecSync.mockImplementation(() => { throw new Error("build failed"); });
      expect(runPreflightCheck()).toBe(false);
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

  describe("commitCycleCount", () => {
    it("returns true on successful commit", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      expect(commitCycleCount(42)).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["add", "CYCLE_COUNT"],
        expect.objectContaining({ timeout: 30_000 }),
      );
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["commit", "-m", "cycle 42"],
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it("returns false when git add fails", () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error("add failed"); });
      expect(commitCycleCount(42)).toBe(false);
    });

    it("returns false when git commit fails", () => {
      mockedExecFileSync
        .mockReturnValueOnce(Buffer.from(""))
        .mockImplementationOnce(() => { throw new Error("nothing to commit"); });
      expect(commitCycleCount(42)).toBe(false);
    });
  });

  describe("pushChanges", () => {
    it("returns true on successful push", () => {
      mockedExecSync.mockReturnValue(Buffer.from(""));
      expect(pushChanges()).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        "git push origin main",
        expect.objectContaining({ timeout: 60_000 }),
      );
    });

    it("returns false when push fails", () => {
      mockedExecSync.mockImplementation(() => { throw new Error("push rejected"); });
      expect(pushChanges()).toBe(false);
    });
  });

  describe("pushTags", () => {
    it("returns true on successful tag push", () => {
      mockedExecSync.mockReturnValue(Buffer.from(""));
      expect(pushTags()).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        "git push --tags",
        expect.objectContaining({ timeout: 60_000 }),
      );
    });

    it("returns false when tag push fails", () => {
      mockedExecSync.mockImplementation(() => { throw new Error("push rejected"); });
      expect(pushTags()).toBe(false);
    });
  });

  describe("verifyBuild", () => {
    it("returns true when build+test succeeds", () => {
      mockedExecSync.mockReturnValue(Buffer.from(""));
      expect(verifyBuild()).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        "pnpm build && pnpm test",
        expect.objectContaining({ timeout: 120_000 }),
      );
    });

    it("returns false when build+test fails", () => {
      mockedExecSync.mockImplementation(() => { throw new Error("test failed"); });
      expect(verifyBuild()).toBe(false);
    });
  });

  describe("revertUncommitted", () => {
    it("runs git checkout . on success", () => {
      mockedExecSync.mockReturnValue(Buffer.from(""));
      revertUncommitted();
      expect(mockedExecSync).toHaveBeenCalledWith(
        "git checkout .",
        expect.objectContaining({ timeout: 10_000 }),
      );
    });

    it("does not throw when git checkout fails", () => {
      mockedExecSync.mockImplementation(() => { throw new Error("checkout failed"); });
      expect(() => revertUncommitted()).not.toThrow();
    });
  });

  describe("createSafetyTag", () => {
    it("creates a tag using execFileSync for a valid cycle count", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      expect(createSafetyTag(42)).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["tag", "-f", "pre-evolution-cycle-42"],
        expect.objectContaining({ timeout: 30_000 }),
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
        expect.objectContaining({ timeout: 10_000 }),
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
    it("returns true when build passes on first attempt", () => {
      mockedExecSync.mockReturnValue(Buffer.from(""));
      expect(runBuildVerification(42)).toBe(true);
      // verifyBuild called once, revertUncommitted not called
      expect(mockedExecSync).toHaveBeenCalledTimes(1);
    });

    it("retries and returns true when build passes on second attempt", () => {
      mockedExecSync
        .mockImplementationOnce(() => { throw new Error("build failed"); }) // attempt 1: verifyBuild fails
        .mockReturnValueOnce(Buffer.from(""))  // attempt 1: revertUncommitted (git checkout .)
        .mockReturnValueOnce(Buffer.from("")); // attempt 2: verifyBuild passes
      expect(runBuildVerification(42)).toBe(true);
    });

    it("reverts between attempts but not after last attempt", () => {
      const calls: string[] = [];
      mockedExecSync.mockImplementation((cmd: unknown) => {
        const cmdStr = String(cmd);
        calls.push(cmdStr);
        if (cmdStr.includes("pnpm")) throw new Error("build failed");
        return Buffer.from("");
      });
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      // All 3 builds fail → hard reset
      expect(runBuildVerification(42, 3)).toBe(false);
      // Should have: build, revert, build, revert, build (no revert after last)
      const revertCount = calls.filter(c => c.includes("checkout")).length;
      expect(revertCount).toBe(2);
    });

    it("hard resets and returns false when all attempts fail", () => {
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (String(cmd).includes("pnpm")) throw new Error("build failed");
        return Buffer.from("");
      });
      mockedExecFileSync.mockReturnValue(Buffer.from(""));
      expect(runBuildVerification(42, 3)).toBe(false);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "git",
        ["reset", "--hard", "pre-evolution-cycle-42"],
        expect.objectContaining({ timeout: 10_000 }),
      );
    });

    it("throws when hard reset fails (manual intervention needed)", () => {
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (String(cmd).includes("pnpm")) throw new Error("build failed");
        return Buffer.from("");
      });
      mockedExecFileSync.mockImplementation(() => { throw new Error("reset failed"); });
      expect(() => runBuildVerification(42, 3)).toThrow();
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
