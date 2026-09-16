/**
 * Livestream block schema tests (Phase 1).
 *
 * Pure-function tests: createDefaultBlock, sanitizeLivestreamChannel, and
 * the isValidPage structural validator for the new "livestream" block type.
 */
import { describe, expect, it } from "vitest";
import {
  BLOCK_TYPES,
  createDefaultBlock,
  isValidPage,
  sanitizeLivestreamChannel,
} from "./schema";

function basePage(blocks: unknown[]) {
  return {
    version: 1,
    username: "test-user",
    theme: { background: "#000", foreground: "#fff", accent: "#f0f", fontFamily: "sans" },
    blocks,
  };
}

describe("livestream block schema", () => {
  it("is registered in BLOCK_TYPES", () => {
    expect((BLOCK_TYPES as readonly string[])).toContain("livestream");
  });

  it("createDefaultBlock returns a twitch block with an empty channel", () => {
    const b = createDefaultBlock("livestream");
    expect(b).toEqual({ type: "livestream", platform: "twitch", channel: "" });
  });

  it("isValidPage accepts a well-formed livestream block", () => {
    const page = basePage([
      { type: "livestream", platform: "twitch", channel: "some_channel" },
      { type: "livestream", platform: "youtube", channel: "UC1234567890123456789012", title: "My stream" },
    ]);
    expect(isValidPage(page)).toBe(true);
  });

  it("isValidPage rejects unknown platforms", () => {
    const page = basePage([{ type: "livestream", platform: "kick", channel: "x" }]);
    expect(isValidPage(page)).toBe(false);
  });

  it("isValidPage rejects non-string or overlong channels", () => {
    expect(isValidPage(basePage([{ type: "livestream", platform: "twitch", channel: 42 }]))).toBe(false);
    expect(
      isValidPage(basePage([{ type: "livestream", platform: "twitch", channel: "x".repeat(65) }]))
    ).toBe(false);
  });

  it("isValidPage rejects non-string titles", () => {
    expect(
      isValidPage(basePage([{ type: "livestream", platform: "twitch", channel: "x", title: 7 }]))
    ).toBe(false);
  });

  it("isValidPage still rejects unknown block types", () => {
    expect(isValidPage(basePage([{ type: "nope", channel: "x" }]))).toBe(false);
  });
});

describe("sanitizeLivestreamChannel", () => {
  it("accepts valid Twitch channel names", () => {
    expect(sanitizeLivestreamChannel("twitch", "ninja")).toBe("ninja");
    expect(sanitizeLivestreamChannel("twitch", "Some_Channel123")).toBe("Some_Channel123");
    expect(sanitizeLivestreamChannel("twitch", "  ninja  ")).toBe("ninja");
  });

  it("rejects bad Twitch channel names", () => {
    expect(sanitizeLivestreamChannel("twitch", "")).toBeNull();
    expect(sanitizeLivestreamChannel("twitch", "has space")).toBeNull();
    expect(sanitizeLivestreamChannel("twitch", "no-dashes")).toBeNull();
    expect(sanitizeLivestreamChannel("twitch", "x".repeat(26))).toBeNull();
    expect(sanitizeLivestreamChannel("twitch", "https://twitch.tv/ninja")).toBeNull();
    expect(sanitizeLivestreamChannel("twitch", "<script>")).toBeNull();
  });

  it("accepts YouTube UC… channel IDs and rejects @handles", () => {
    expect(sanitizeLivestreamChannel("youtube", "UC1234567890123456789012")).toBe(
      "UC1234567890123456789012"
    );
    expect(sanitizeLivestreamChannel("youtube", "@somehandle")).toBeNull();
    expect(sanitizeLivestreamChannel("youtube", "somehandle")).toBeNull();
    expect(sanitizeLivestreamChannel("youtube", "UCshort")).toBeNull();
    expect(sanitizeLivestreamChannel("youtube", "")).toBeNull();
  });
});
