import { afterEach, describe, expect, it } from "vitest";
import {
  deriveUsername,
  isAccountId,
  isValidUsername,
  normalizeUsername,
} from "./identity";

describe("deriveUsername", () => {
  it("derives user-10424063 from 0.0.10424063", () => {
    expect(deriveUsername("0.0.10424063")).toBe("user-10424063");
  });

  it("handles small account numbers", () => {
    expect(deriveUsername("0.0.2")).toBe("user-2");
  });

  it("trims whitespace", () => {
    expect(deriveUsername("  0.0.123  ")).toBe("user-123");
  });

  it("returns null for non-Hedera formats", () => {
    expect(deriveUsername("0x1234567890123456789012345678901234567890")).toBeNull();
    expect(deriveUsername("brandon")).toBeNull();
    expect(deriveUsername("")).toBeNull();
    expect(deriveUsername("0.0")).toBeNull();
    expect(deriveUsername("0.1.123")).toBeNull();
  });

  it("returns null when the derived name would be too long", () => {
    // user- + 20 digits = 25 chars > 24-char username cap
    expect(deriveUsername("0.0.12345678901234567890")).toBeNull();
  });
});

describe("normalizeUsername", () => {
  it("maps an account id to its derived username", () => {
    expect(normalizeUsername("0.0.10424063")).toBe("user-10424063");
  });

  it("passes plain usernames through lowercased and trimmed", () => {
    expect(normalizeUsername("  0xCreator ")).toBe("0xcreator");
    expect(normalizeUsername("user-10424063")).toBe("user-10424063");
  });
});

describe("isAccountId", () => {
  it("accepts 0.0.x", () => {
    expect(isAccountId("0.0.10424063")).toBe(true);
    expect(isAccountId(" 0.0.2 ")).toBe(true);
  });

  it("rejects other formats", () => {
    expect(isAccountId("0xcreator")).toBe(false);
    expect(isAccountId("user-10424063")).toBe(false);
    expect(isAccountId("")).toBe(false);
  });
});

describe("isValidUsername", () => {
  it("matches the on-chain charset rules", () => {
    expect(isValidUsername("0xcreator")).toBe(true);
    expect(isValidUsername("user-10424063")).toBe(true);
    expect(isValidUsername("ab")).toBe(false); // too short
    expect(isValidUsername("a".repeat(25))).toBe(false); // too long
    expect(isValidUsername("UPPER")).toBe(false);
    expect(isValidUsername("with space")).toBe(false);
    expect(isValidUsername("with_underscore")).toBe(false);
  });
});

describe("fetchRegisteredUsername", () => {
  const realFetch = globalThis.fetch;

  function mockFetch(handler: (url: string) => { status: number; body: unknown }) {
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => ({
      status: handler(url).status,
      ok: handler(url).status >= 200 && handler(url).status < 300,
      json: async () => handler(url).body,
    });
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns the username when the account owns a page", async () => {
    const { fetchRegisteredUsername } = await import("./identity");
    mockFetch((url) => {
      expect(url).toContain("/api/resolve?owner=");
      expect(url).toContain(encodeURIComponent("0.0.10425049"));
      return { status: 200, body: { username: "user-10425049" } };
    });
    expect(await fetchRegisteredUsername("0.0.10425049")).toBe("user-10425049");
  });

  it("returns null on 404 (no page registered)", async () => {
    const { fetchRegisteredUsername } = await import("./identity");
    mockFetch(() => ({ status: 404, body: { error: "no page registered for this account" } }));
    expect(await fetchRegisteredUsername("0.0.99999999")).toBeNull();
  });

  it("throws on transport errors so the caller can fail open", async () => {
    const { fetchRegisteredUsername } = await import("./identity");
    mockFetch(() => ({ status: 503, body: { error: "down" } }));
    await expect(fetchRegisteredUsername("0.0.10425049")).rejects.toThrow();
  });
});
