/** One-time claim congrats flag for Buddy's page (/forge). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAIM_CONGRATS_LS_KEY,
  CLAIM_CONGRATS_TTL_MS,
  clearClaimCongrats,
  markClaimCongratsSeen,
  readClaimCongrats,
  stashClaimCongrats,
} from "./claim-congrats";

function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  });
  return store;
}

beforeEach(() => {
  stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("claim congrats flag", () => {
  it("set -> read returns unseen -> markSeen -> read returns seen", () => {
    stashClaimCongrats("Bacon", "0.0.1234");
    const first = readClaimCongrats(Date.now(), "0.0.1234");
    expect(first).not.toBeNull();
    expect(first?.username).toBe("bacon");
    expect(first?.seen).toBe(false);

    markClaimCongratsSeen();

    const second = readClaimCongrats(Date.now(), "0.0.1234");
    expect(second).not.toBeNull();
    expect(second?.seen).toBe(true);
  });

  it("returns null when nothing was stashed", () => {
    expect(readClaimCongrats(Date.now(), "0.0.1234")).toBeNull();
  });

  it("drops an expired entry without showing it", () => {
    const store = stubStorage();
    store.set(
      CLAIM_CONGRATS_LS_KEY,
      JSON.stringify({
        username: "bacon",
        wallet: "0.0.1234",
        atMs: Date.now() - CLAIM_CONGRATS_TTL_MS - 1000,
        seen: false,
      }),
    );
    expect(readClaimCongrats(Date.now(), "0.0.1234")).toBeNull();
    expect(store.has(CLAIM_CONGRATS_LS_KEY)).toBe(false);
  });

  it("drops a malformed entry silently", () => {
    const store = stubStorage();
    store.set(CLAIM_CONGRATS_LS_KEY, "not-json{{");
    expect(readClaimCongrats(Date.now(), "0.0.1234")).toBeNull();
    expect(store.has(CLAIM_CONGRATS_LS_KEY)).toBe(false);
  });

  it("drops an entry with a missing username", () => {
    const store = stubStorage();
    store.set(CLAIM_CONGRATS_LS_KEY, JSON.stringify({ atMs: Date.now(), seen: false }));
    expect(readClaimCongrats(Date.now(), "0.0.1234")).toBeNull();
    expect(store.has(CLAIM_CONGRATS_LS_KEY)).toBe(false);
  });

  it("does not show the card to a different wallet", () => {
    stashClaimCongrats("bacon", "0.0.1234");
    expect(readClaimCongrats(Date.now(), "0.0.9999")).toBeNull();
    // Not consumed by the wrong wallet — the right wallet still sees it.
    const rec = readClaimCongrats(Date.now(), "0.0.1234");
    expect(rec?.seen).toBe(false);
  });

  it("clearClaimCongrats removes a pending flag", () => {
    stashClaimCongrats("bacon", "0.0.1234");
    clearClaimCongrats();
    expect(readClaimCongrats(Date.now(), "0.0.1234")).toBeNull();
  });

  it("a later claim overwrites an earlier pending flag", () => {
    stashClaimCongrats("bacon", "0.0.1234");
    stashClaimCongrats("maya", "0.0.1234");
    const rec = readClaimCongrats(Date.now(), "0.0.1234");
    expect(rec?.username).toBe("maya");
  });

  it("never throws when storage is unavailable", () => {
    vi.unstubAllGlobals();
    expect(readClaimCongrats(Date.now(), "0.0.1234")).toBeNull();
    expect(() => stashClaimCongrats("bacon", "0.0.1234")).not.toThrow();
    expect(() => markClaimCongratsSeen()).not.toThrow();
    expect(() => clearClaimCongrats()).not.toThrow();
  });
});
