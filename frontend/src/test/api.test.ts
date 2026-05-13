import { describe, it, expect } from "vitest";
import { extractErrorMessage } from "../api";

describe("extractErrorMessage", () => {
  it("returns the trimmed raw string for plain text errors", () => {
    expect(extractErrorMessage("  something went wrong  ")).toBe("something went wrong");
  });

  it("returns an empty string for empty input", () => {
    expect(extractErrorMessage("")).toBe("");
  });

  it("extracts `detail` from a Vercel-style error payload", () => {
    const raw = JSON.stringify({ detail: "Sign in before using this workspace control." });
    expect(extractErrorMessage(raw)).toBe("Sign in before using this workspace control.");
  });

  it("extracts `msg` from a nested FastAPI pydantic validation payload", () => {
    const raw = JSON.stringify({
      detail: [
        { type: "too_short", loc: ["body", "asset_ids"], msg: "List should have at least 2 items after validation, not 1" }
      ]
    });
    expect(extractErrorMessage(raw)).toBe("List should have at least 2 items after validation, not 1");
  });

  it("extracts `error` when neither detail nor message is present", () => {
    expect(extractErrorMessage(JSON.stringify({ error: "Boom." }))).toBe("Boom.");
  });

  it("falls back to the trimmed raw string when JSON has no recognizable error field", () => {
    const raw = JSON.stringify({ unrelated: "field" });
    expect(extractErrorMessage(raw)).toBe(raw);
  });
});
