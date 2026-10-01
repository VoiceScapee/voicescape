/**
 * Tests for the agent availability signal ("open for work" flag).
 *
 * Covers: username normalization, strict stored-value parsing, KV
 * read/write/clear, the POST/DELETE route cores (401/403/404/400/200),
 * directory attach + the available=true filter, and TTL behavior (expired
 * flags read back as null — the directory never shows a stale "open").
 */
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_AVAILABILITY_TTL_MS,
  availabilityKey,
  clearAvailability,
  clearAvailabilityCore,
  normalizeAgentUsername,
  parseAvailability,
  readAvailability,
  setAvailabilityCore,
  writeAvailability,
  type AvailabilityDeps,
} from "./agent-availability";
import {
  applyFilters,
  attachAvailability,
  type DirectoryAgent,
} from "./agents-directory";
import type { KvStore } from "./store";

const OWNER = `0x${"ab".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;
const NOW = 1_759_000_000_000;

/** Minimal in-memory KvStore for tests. */
function fakeStore() {
  const data = new Map<string, string>();
  const sets: Array<{ key: string; val: string; ttlMs: number }> = [];
  const dels: string[] = [];
  const store: KvStore = {
    async incr() {
      return 1;
    },
    async setNx() {
      return true;
    },
    async set(key, val, ttlMs) {
      sets.push({ key, val, ttlMs });
      data.set(key, val);
    },
    async get(key) {
      return data.get(key) ?? null;
    },
    async del(key) {
      dels.push(key);
      data.delete(key);
    },
    async clearPrefix() {},
  };
  return { store, data, sets, dels };
}

function fakeDeps(overrides: Partial<AvailabilityDeps> = {}) {
  const { store, data, sets, dels } = fakeStore();
  const deps: AvailabilityDeps = {
    verifySession: async () => ({ ok: true as const, address: OWNER }),
    resolvePage: async () => ({ owner: OWNER, ownerType: 1 }),
    store,
    nowMs: () => NOW,
    ...overrides,
  };
  return { deps, store, data, sets, dels };
}

function fakeDirectoryAgent(username: string): DirectoryAgent {
  return {
    username,
    owner: OWNER,
    operator: OTHER,
    purpose: "test agent",
    ipfsHash: "",
    pageUrl: "https://test.local/agent",
    capabilities: [],
    services: [],
    reputation: null,
    verifiedReviews: null,
    availability: null,
    registeredAt: null,
  };
}

describe("normalizeAgentUsername", () => {
  it("lowercases and strips a leading @", () => {
    expect(normalizeAgentUsername("Forge")).toBe("forge");
    expect(normalizeAgentUsername("@forge")).toBe("forge");
    expect(normalizeAgentUsername("  forge_2 ")).toBe("forge_2");
  });

  it("rejects malformed names", () => {
    expect(normalizeAgentUsername("ab")).toBeNull(); // too short
    expect(normalizeAgentUsername("a".repeat(33))).toBeNull(); // too long
    expect(normalizeAgentUsername("not a name")).toBeNull();
    expect(normalizeAgentUsername("UPPER NAME!")).toBeNull();
    expect(normalizeAgentUsername("")).toBeNull();
    expect(normalizeAgentUsername(null)).toBeNull();
    expect(normalizeAgentUsername(42)).toBeNull();
  });
});

describe("parseAvailability", () => {
  it("parses a well-formed stored value", () => {
    expect(
      parseAvailability(JSON.stringify({ open: true, updatedAt: "2026-09-30T00:00:00.000Z" })),
    ).toEqual({ open: true, updatedAt: "2026-09-30T00:00:00.000Z" });
  });

  it("returns null for missing or corrupt values", () => {
    expect(parseAvailability(null)).toBeNull();
    expect(parseAvailability("")).toBeNull();
    expect(parseAvailability("not-json")).toBeNull();
    expect(parseAvailability(JSON.stringify({ open: "yes", updatedAt: "2026-09-30T00:00:00.000Z" }))).toBeNull();
    expect(parseAvailability(JSON.stringify({ open: true }))).toBeNull();
    expect(parseAvailability(JSON.stringify({ open: true, updatedAt: "yesterday" }))).toBeNull();
    expect(parseAvailability(JSON.stringify([1, 2, 3]))).toBeNull();
  });
});

describe("read/write/clearAvailability", () => {
  it("writes JSON with the 30-day TTL and reads it back", async () => {
    const { store, sets } = fakeStore();
    const written = await writeAvailability("forge", true, store, NOW);
    expect(written).toEqual({ open: true, updatedAt: new Date(NOW).toISOString() });
    expect(sets).toHaveLength(1);
    expect(sets[0].key).toBe(availabilityKey("forge"));
    expect(sets[0].ttlMs).toBe(AGENT_AVAILABILITY_TTL_MS);
    expect(AGENT_AVAILABILITY_TTL_MS).toBe(30 * 24 * 3600 * 1000);
    expect(await readAvailability("forge", store)).toEqual(written);
  });

  it("reads null when the key is missing (unset or TTL-expired)", async () => {
    const { store } = fakeStore();
    expect(await readAvailability("ghost", store)).toBeNull();
  });

  it("reads null when the store throws (fail closed, no stale badge)", async () => {
    const { store } = fakeStore();
    vi.spyOn(store, "get").mockRejectedValueOnce(new Error("down"));
    expect(await readAvailability("forge", store)).toBeNull();
  });

  it("clears the flag", async () => {
    const { store, dels } = fakeStore();
    await writeAvailability("forge", true, store, NOW);
    await clearAvailability("forge", store);
    expect(dels).toEqual([availabilityKey("forge")]);
    expect(await readAvailability("forge", store)).toBeNull();
  });
});

describe("setAvailabilityCore (POST)", () => {
  it("401 when no session credential", async () => {
    const { deps } = fakeDeps();
    const r = await setAvailabilityCore("forge", { open: true }, null, deps);
    expect(r.status).toBe(401);
  });

  it("401 when the session does not verify", async () => {
    const { deps } = fakeDeps({
      verifySession: async () => ({ ok: false as const, error: "expired" }),
    });
    const r = await setAvailabilityCore("forge", { open: true }, "tok", deps);
    expect(r.status).toBe(401);
  });

  it("400 for a malformed username", async () => {
    const { deps } = fakeDeps();
    const r = await setAvailabilityCore("no good", { open: true }, "tok", deps);
    expect(r.status).toBe(400);
  });

  it("400 for an invalid body", async () => {
    const { deps } = fakeDeps();
    for (const body of [null, {}, { open: "yes" }, { open: 1 }, "true", []] as const) {
      const r = await setAvailabilityCore("forge", body, "tok", deps);
      expect(r.status).toBe(400);
    }
  });

  it("503 when the registry is unreachable", async () => {
    const { deps } = fakeDeps({
      resolvePage: async () => {
        throw new Error("down");
      },
    });
    const r = await setAvailabilityCore("forge", { open: true }, "tok", deps);
    expect(r.status).toBe(503);
  });

  it("404 when the agent is not registered", async () => {
    const { deps } = fakeDeps({ resolvePage: async () => null });
    const r = await setAvailabilityCore("ghost", { open: true }, "tok", deps);
    expect(r.status).toBe(404);
  });

  it("403 when the session wallet does not own the page", async () => {
    const { deps } = fakeDeps({ resolvePage: async () => ({ owner: OTHER, ownerType: 1 }) });
    const r = await setAvailabilityCore("forge", { open: true }, "tok", deps);
    expect(r.status).toBe(403);
  });

  it("400 for a human page (availability is agents-only)", async () => {
    const { deps } = fakeDeps({ resolvePage: async () => ({ owner: OWNER, ownerType: 0 }) });
    const r = await setAvailabilityCore("human", { open: true }, "tok", deps);
    expect(r.status).toBe(400);
  });

  it("200: the owner can set the flag (open and closed)", async () => {
    const { deps, data } = fakeDeps();
    for (const open of [true, false] as const) {
      const r = await setAvailabilityCore("forge", { open }, "tok", deps);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({
        ok: true,
        username: "forge",
        availability: { open, updatedAt: new Date(NOW).toISOString() },
      });
      expect(parseAvailability(data.get(availabilityKey("forge")) ?? null)).toEqual({
        open,
        updatedAt: new Date(NOW).toISOString(),
      });
    }
  });

  it("503 when the store is unavailable on write", async () => {
    const { deps, store } = fakeDeps();
    vi.spyOn(store, "set").mockRejectedValueOnce(new Error("down"));
    const r = await setAvailabilityCore("forge", { open: true }, "tok", deps);
    expect(r.status).toBe(503);
  });
});

describe("clearAvailabilityCore (DELETE)", () => {
  it("401 when no session credential", async () => {
    const { deps } = fakeDeps();
    const r = await clearAvailabilityCore("forge", null, deps);
    expect(r.status).toBe(401);
  });

  it("403 when the session wallet does not own the page", async () => {
    const { deps } = fakeDeps({ resolvePage: async () => ({ owner: OTHER, ownerType: 1 }) });
    const r = await clearAvailabilityCore("forge", "tok", deps);
    expect(r.status).toBe(403);
  });

  it("200: the owner can clear the flag", async () => {
    const { deps, data, dels } = fakeDeps();
    await writeAvailability("forge", true, deps.store, NOW);
    const r = await clearAvailabilityCore("forge", "tok", deps);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, username: "forge", cleared: true });
    expect(dels).toEqual([availabilityKey("forge")]);
    expect(data.has(availabilityKey("forge"))).toBe(false);
  });
});

describe("directory: attachAvailability + available filter", () => {
  it("attaches flags and maps missing/expired keys to null", async () => {
    const { store } = fakeStore();
    await writeAvailability("forge", true, store, NOW);
    const agents = [fakeDirectoryAgent("forge"), fakeDirectoryAgent("helper")];
    const out = await attachAvailability(agents, store);
    expect(out[0].availability).toEqual({ open: true, updatedAt: new Date(NOW).toISOString() });
    expect(out[1].availability).toBeNull();
  });

  it("available=true keeps only agents with an open flag", () => {
    const open = { ...fakeDirectoryAgent("forge"), availability: { open: true, updatedAt: new Date(NOW).toISOString() } };
    const closed = { ...fakeDirectoryAgent("busy"), availability: { open: false, updatedAt: new Date(NOW).toISOString() } };
    const unset = fakeDirectoryAgent("quiet");
    const agents = [open, closed, unset];

    expect(applyFilters(agents, { available: true }).map((a) => a.username)).toEqual(["forge"]);
    expect(applyFilters(agents, {}).map((a) => a.username)).toEqual(["forge", "busy", "quiet"]);
    expect(applyFilters(agents, { available: false }).map((a) => a.username)).toEqual([
      "forge",
      "busy",
      "quiet",
    ]);
  });

  it("combines with the other filters", () => {
    const a = {
      ...fakeDirectoryAgent("forge"),
      availability: { open: true, updatedAt: new Date(NOW).toISOString() },
      capabilities: ["summarization"],
    };
    const b = {
      ...fakeDirectoryAgent("writer"),
      availability: { open: true, updatedAt: new Date(NOW).toISOString() },
      capabilities: ["copywriting"],
    };
    expect(
      applyFilters([a, b], { available: true, capability: "summar" }).map((x) => x.username),
    ).toEqual(["forge"]);
  });
});
