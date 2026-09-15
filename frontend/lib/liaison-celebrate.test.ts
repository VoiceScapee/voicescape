/** Browser-lane congratulations for a Danny-built page going live. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIAISON_CELEBRATE_LS_KEY,
  LIAISON_CELEBRATE_TTL_MS,
  clearBrowserCelebration,
  congratsText,
  stashBrowserCelebration,
  takeBrowserCelebration,
} from "./liaison-celebrate";

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

describe("congratsText", () => {
  it("names the published page", () => {
    expect(congratsText("bacon")).toContain("@bacon");
  });
});

describe("browser-lane celebration", () => {
  it("stashes and takes a celebration exactly once", () => {
    stashBrowserCelebration("Bacon", "0.0.1234");
    expect(takeBrowserCelebration(Date.now(), "0.0.1234")).toBe("bacon");
    // Second take finds nothing — one-time.
    expect(takeBrowserCelebration(Date.now(), "0.0.1234")).toBeNull();
  });

  it("does not celebrate the wrong wallet after a switch", () => {
    stashBrowserCelebration("bacon", "0.0.1234");
    expect(takeBrowserCelebration(Date.now(), "0.0.9999")).toBeNull();
    // Consumed on read, so the right wallet can't see it later either —
    // the server lane remains the source of truth for that wallet.
    expect(takeBrowserCelebration(Date.now(), "0.0.1234")).toBeNull();
  });

  it("drops a stale entry without showing it", () => {
    const store = stubStorage();
    store.set(
      LIAISON_CELEBRATE_LS_KEY,
      JSON.stringify({
        username: "bacon",
        wallet: "0.0.1234",
        atMs: Date.now() - LIAISON_CELEBRATE_TTL_MS - 1000,
      }),
    );
    expect(takeBrowserCelebration(Date.now(), "0.0.1234")).toBeNull();
    expect(store.has(LIAISON_CELEBRATE_LS_KEY)).toBe(false);
  });

  it("consumes a malformed entry silently", () => {
    const store = stubStorage();
    store.set(LIAISON_CELEBRATE_LS_KEY, "not-json{{");
    expect(takeBrowserCelebration(Date.now(), "0.0.1234")).toBeNull();
    expect(store.has(LIAISON_CELEBRATE_LS_KEY)).toBe(false);
  });

  it("clearBrowserCelebration prevents a later double-fire", () => {
    stashBrowserCelebration("bacon", "0.0.1234");
    clearBrowserCelebration();
    expect(takeBrowserCelebration(Date.now(), "0.0.1234")).toBeNull();
  });

  it("returns null when storage is unavailable", () => {
    vi.unstubAllGlobals();
    expect(takeBrowserCelebration(Date.now(), "0.0.1234")).toBeNull();
    expect(() => stashBrowserCelebration("bacon", "0.0.1234")).not.toThrow();
    expect(() => clearBrowserCelebration()).not.toThrow();
  });
});
