import { describe, expect, it } from "vitest";
import { draftFileUrl, sanitizeDraftName } from "./drafts";

describe("sanitizeDraftName", () => {
  it("accepts simple lowercase names", () => {
    expect(sanitizeDraftName("brandon")).toBe("brandon");
    expect(sanitizeDraftName("my-draft-2")).toBe("my-draft-2");
  });

  it("normalizes case and trims whitespace", () => {
    expect(sanitizeDraftName("  Brandon ")).toBe("brandon");
  });

  it("rejects null, empty, and missing values", () => {
    expect(sanitizeDraftName(null)).toBeNull();
    expect(sanitizeDraftName(undefined)).toBeNull();
    expect(sanitizeDraftName("")).toBeNull();
    expect(sanitizeDraftName("   ")).toBeNull();
  });

  it("rejects path traversal and injection attempts", () => {
    expect(sanitizeDraftName("../secret")).toBeNull();
    expect(sanitizeDraftName("..%2fsecret")).toBeNull();
    expect(sanitizeDraftName("brandon.json")).toBeNull();
    expect(sanitizeDraftName("brandon?x=1")).toBeNull();
    expect(sanitizeDraftName("a/b")).toBeNull();
    expect(sanitizeDraftName("draft;rm")).toBeNull();
  });

  it("rejects overlong names", () => {
    expect(sanitizeDraftName("a".repeat(33))).toBeNull();
    expect(sanitizeDraftName("a".repeat(32))).toBe("a".repeat(32));
  });
});

describe("draftFileUrl", () => {
  it("builds the public drafts path", () => {
    expect(draftFileUrl("brandon")).toBe("/drafts/brandon.json");
  });
});
