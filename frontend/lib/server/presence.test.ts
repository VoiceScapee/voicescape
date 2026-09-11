/**
 * Presence merge/count tests — pure functions, no I/O.
 */
import { describe, expect, it } from "vitest";
import {
  PRESENCE_MAX_ENTRIES,
  PRESENCE_TTL_MS,
  countPresence,
  isValidPresenceId,
  isValidPresenceScope,
  mergePresence,
} from "./presence";

const NOW = 1_700_000_000_000;

function entry(id: string, ageMs: number): string {
  return JSON.stringify([{ id, ts: NOW - ageMs }]);
}

describe("mergePresence", () => {
  it("adds a new id to an empty store", () => {
    const out = mergePresence(null, "tab-1", NOW);
    expect(out).toEqual([{ id: "tab-1", ts: NOW }]);
  });

  it("refreshes an existing id instead of duplicating it", () => {
    const out = mergePresence(entry("tab-1", 10_000), "tab-1", NOW);
    expect(out).toEqual([{ id: "tab-1", ts: NOW }]);
  });

  it("keeps other fresh ids and drops expired ones", () => {
    const raw = JSON.stringify([
      { id: "fresh", ts: NOW - 10_000 },
      { id: "stale", ts: NOW - PRESENCE_TTL_MS - 1 },
    ]);
    const out = mergePresence(raw, "tab-1", NOW);
    expect(out.map((e) => e.id).sort()).toEqual(["fresh", "tab-1"]);
  });

  it("tolerates corrupt JSON", () => {
    const out = mergePresence("not-json{{{", "tab-1", NOW);
    expect(out).toEqual([{ id: "tab-1", ts: NOW }]);
  });

  it("caps the array length", () => {
    const many = Array.from({ length: PRESENCE_MAX_ENTRIES + 50 }, (_, i) => ({
      id: `tab-${i}`,
      ts: NOW - 1_000,
    }));
    const out = mergePresence(JSON.stringify(many), "tab-new", NOW);
    expect(out.length).toBe(PRESENCE_MAX_ENTRIES);
    expect(out[out.length - 1].id).toBe("tab-new");
  });
});

describe("countPresence", () => {
  it("counts only unexpired entries", () => {
    const raw = JSON.stringify([
      { id: "a", ts: NOW - 1_000 },
      { id: "b", ts: NOW - PRESENCE_TTL_MS - 1 },
    ]);
    expect(countPresence(raw, NOW)).toBe(1);
  });

  it("returns 0 for missing or corrupt data", () => {
    expect(countPresence(null, NOW)).toBe(0);
    expect(countPresence("garbage", NOW)).toBe(0);
  });
});

describe("validators", () => {
  it("accepts well-formed scopes", () => {
    expect(isValidPresenceScope("chat:lobby")).toBe(true);
    expect(isValidPresenceScope("forum:general")).toBe(true);
    expect(isValidPresenceScope("polls")).toBe(true);
  });

  it("rejects malformed scopes", () => {
    expect(isValidPresenceScope("")).toBe(false);
    expect(isValidPresenceScope("chat lobby")).toBe(false);
    expect(isValidPresenceScope("x".repeat(70))).toBe(false);
    expect(isValidPresenceScope(null)).toBe(false);
  });

  it("accepts well-formed ids and rejects junk", () => {
    expect(isValidPresenceId("user:brandon")).toBe(true);
    expect(isValidPresenceId("tab-abc123")).toBe(true);
    expect(isValidPresenceId("")).toBe(false);
    expect(isValidPresenceId("a b")).toBe(false);
    expect(isValidPresenceId(null)).toBe(false);
  });
});
