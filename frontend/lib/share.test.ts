import { describe, expect, it } from "vitest";
import {
  buildFacebookShareUrl,
  buildPageShareUrl,
  buildShareText,
  buildXShareUrl,
  normalizeRef,
} from "./share";

describe("normalizeRef", () => {
  it("lowercases and trims", () => {
    expect(normalizeRef("  Alice-1 ")).toBe("alice-1");
  });
});

describe("buildPageShareUrl", () => {
  it("embeds the referral code in the shared URL", () => {
    expect(
      buildPageShareUrl("https://voicescape.vercel.app", "user-10424063"),
    ).toBe("https://voicescape.vercel.app/user-10424063?ref=user-10424063");
  });

  it("strips trailing slashes from the origin", () => {
    expect(buildPageShareUrl("https://example.com///", "alice")).toBe(
      "https://example.com/alice?ref=alice",
    );
  });

  it("lowercases the ref param", () => {
    const url = buildPageShareUrl("https://example.com", "Alice");
    expect(url).toContain("?ref=alice");
  });
});

describe("buildShareText", () => {
  it("mentions the username and Voicescape", () => {
    expect(buildShareText("alice")).toBe(
      "Check out alice's blockpage on Voicescape",
    );
  });
});

describe("buildXShareUrl", () => {
  it("builds a valid X intent URL with encoded params", () => {
    const pageUrl = "https://voicescape.vercel.app/alice?ref=alice";
    const url = buildXShareUrl(pageUrl, "Check out alice's blockpage");
    expect(url.startsWith("https://x.com/intent/post?")).toBe(true);
    expect(url).toContain(`url=${encodeURIComponent(pageUrl)}`);
    expect(url).toContain(`text=${encodeURIComponent("Check out alice's blockpage")}`);
  });
});

describe("buildFacebookShareUrl", () => {
  it("builds a valid Facebook sharer URL with the encoded page URL", () => {
    const pageUrl = "https://voicescape.vercel.app/alice?ref=alice";
    expect(buildFacebookShareUrl(pageUrl)).toBe(
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl)}`,
    );
  });
});
