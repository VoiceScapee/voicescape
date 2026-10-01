import { describe, expect, it } from "vitest";
import {
  EMBED_HEIGHT,
  EMBED_TIP_PATH,
  EMBED_WIDTH,
  buildEmbedTipSnippet,
  buildEmbedTipUrl,
  normalizeEmbedAmount,
  normalizeEmbedUsername,
} from "./embed";

describe("normalizeEmbedUsername", () => {
  it("accepts a plain valid username", () => {
    expect(normalizeEmbedUsername("bacon-the-dino")).toBe("bacon-the-dino");
  });
  it("strips a leading @ and surrounding whitespace", () => {
    expect(normalizeEmbedUsername("  @Bacon-The-Dino  ")).toBe("bacon-the-dino");
  });
  it("accepts wallet-derived usernames", () => {
    expect(normalizeEmbedUsername("user-10424063")).toBe("user-10424063");
  });
  it("rejects empty input", () => {
    expect(normalizeEmbedUsername("")).toBeNull();
    expect(normalizeEmbedUsername("   ")).toBeNull();
    expect(normalizeEmbedUsername("@")).toBeNull();
  });
  it("rejects usernames outside the on-chain charset", () => {
    expect(normalizeEmbedUsername("not a name!")).toBeNull();
    expect(normalizeEmbedUsername("a".repeat(25))).toBeNull(); // too long
    expect(normalizeEmbedUsername("ab")).toBeNull(); // too short
    expect(normalizeEmbedUsername("has_underscore")).toBeNull();
  });
});

describe("normalizeEmbedAmount", () => {
  it("passes sane amounts through, rounded", () => {
    expect(normalizeEmbedAmount(5)).toBe(5);
    expect(normalizeEmbedAmount(2.6)).toBe(3);
  });
  it("rejects out-of-range and non-numeric input", () => {
    expect(normalizeEmbedAmount(0)).toBeNull();
    expect(normalizeEmbedAmount(-5)).toBeNull();
    expect(normalizeEmbedAmount(1001)).toBeNull();
    expect(normalizeEmbedAmount(NaN)).toBeNull();
    expect(normalizeEmbedAmount("5")).toBeNull();
    expect(normalizeEmbedAmount(undefined)).toBeNull();
  });
});

describe("buildEmbedTipUrl", () => {
  it("builds the canonical widget URL", () => {
    expect(buildEmbedTipUrl("bacon-the-dino")).toBe(
      `https://voicescape.vercel.app${EMBED_TIP_PATH}/bacon-the-dino`,
    );
  });
  it("normalizes the username in the URL", () => {
    expect(buildEmbedTipUrl(" @User-10424063 ")).toContain("/user-10424063");
  });
  it("appends a valid amount param", () => {
    expect(buildEmbedTipUrl("bacon-the-dino", { amount: 10 })).toBe(
      `https://voicescape.vercel.app${EMBED_TIP_PATH}/bacon-the-dino?amount=10`,
    );
  });
  it("drops invalid amounts instead of emitting them", () => {
    expect(buildEmbedTipUrl("bacon-the-dino", { amount: 0 })).not.toContain("amount=");
  });
  it("throws on an invalid username", () => {
    expect(() => buildEmbedTipUrl("not a name!")).toThrow(/Invalid Voicescape username/);
  });
});

describe("buildEmbedTipSnippet", () => {
  it("emits a complete iframe snippet", () => {
    const s = buildEmbedTipSnippet("bacon-the-dino");
    expect(s).toContain("<iframe");
    expect(s).toContain(`src="https://voicescape.vercel.app${EMBED_TIP_PATH}/bacon-the-dino"`);
    expect(s).toContain(`width="${EMBED_WIDTH}"`);
    expect(s).toContain(`height="${EMBED_HEIGHT}"`);
    expect(s).toContain("sandbox=");
    expect(s).toContain('title="Tip @bacon-the-dino on Voicescape"');
  });
  it("carries the amount param into the iframe src", () => {
    expect(buildEmbedTipSnippet("bacon-the-dino", { amount: 25 })).toContain("?amount=25");
  });
  it("keeps every attribute value safely quoted", () => {
    const s = buildEmbedTipSnippet("user-10424063");
    // Every attribute value is wrapped in balanced double quotes with no
    // raw quote or angle bracket inside — the escaper holds even though
    // normalized usernames are already charset-safe.
    const attrs = [...s.matchAll(/="([^"]*)"/g)];
    expect(attrs.length).toBeGreaterThan(0);
    for (const m of attrs) {
      expect(m[1]).not.toMatch(/[<>"']/);
    }
    expect(s).toMatch(/title="Tip @user-10424063 on Voicescape"/);
  });
});
