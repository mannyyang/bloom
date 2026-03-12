import { describe, it, expect } from "vitest";
import { errorMessage } from "../src/errors.js";

describe("errorMessage", () => {
  it("extracts message from Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("extracts message from Error subclasses", () => {
    expect(errorMessage(new TypeError("type error"))).toBe("type error");
  });

  it("returns string values directly", () => {
    expect(errorMessage("something went wrong")).toBe("something went wrong");
  });

  it("returns 'null' for null", () => {
    expect(errorMessage(null)).toBe("null");
  });

  it("returns 'undefined' for undefined", () => {
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("extracts message from plain objects with a message property", () => {
    expect(errorMessage({ message: "obj error" })).toBe("obj error");
  });

  it("stringifies objects without a message property", () => {
    expect(errorMessage({ code: 42 })).toBe("[object Object]");
  });

  it("stringifies numbers", () => {
    expect(errorMessage(42)).toBe("42");
  });

  it("handles empty string", () => {
    expect(errorMessage("")).toBe("");
  });

  it("handles objects where message is not a string", () => {
    expect(errorMessage({ message: 123 })).toBe("[object Object]");
  });
});
