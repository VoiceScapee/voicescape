import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { safeExternalUrl, openExternalUrl } from "./url";

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

describe("openExternalUrl", () => {
  let openSpy: ReturnType<typeof vi.fn>;
  let assignSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openSpy = vi.fn();
    assignSpy = vi.fn();
    vi.stubGlobal("window", { open: openSpy, location: { assign: assignSpy } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens a new tab when the popup succeeds", () => {
    openSpy.mockReturnValue({ closed: false });
    openExternalUrl("https://example.com/page");
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/page",
      "_blank",
      "noopener,noreferrer"
    );
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("falls back to same-tab navigation when the popup is blocked (dapp WebView)", () => {
    openSpy.mockReturnValue(null);
    openExternalUrl("https://example.com/page");
    expect(assignSpy).toHaveBeenCalledWith("https://example.com/page");
  });

  it("falls back to same-tab navigation when window.open throws", () => {
    openSpy.mockImplementation(() => {
      throw new Error("blocked");
    });
    openExternalUrl("https://example.com/page");
    expect(assignSpy).toHaveBeenCalledWith("https://example.com/page");
  });

  it("never opens javascript: URLs", () => {
    openSpy.mockReturnValue({ closed: false });
    openExternalUrl("javascript:alert(1)");
    expect(openSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("does nothing for empty input", () => {
    openExternalUrl("");
    expect(openSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
