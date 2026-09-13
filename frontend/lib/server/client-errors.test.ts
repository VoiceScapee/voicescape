/**
 * Tests for lib/server/client-errors.ts — privacy-first client error
 * reporting: normalizers (the privacy boundary), aggregation, TTL,
 * the founder gate, and the admin stats gate.
 */
import { describe, expect, test } from "vitest";
import { createMemoryKvStore, type KvStore } from "./store";
import {
  CLIENT_ERROR_TTL_MS,
  ERROR_SPIKE_THRESHOLD,
  ERROR_STATS_DAY_COUNT,
  MAX_ERROR_MESSAGE_LEN,
  errorAggKey,
  errorDateKey,
  errorIndexKey,
  founderWallets,
  getClientErrorStats,
  getErrorAggregates,
  hashErrorMessage,
  isFounderWallet,
  normalizeErrorComponent,
  normalizeErrorFrame,
  normalizeErrorMessage,
  normalizeErrorPage,
  recordClientError,
  scrubErrorMessage,
  slugifyErrorPage,
} from "./client-errors";

function mem(): KvStore {
  return createMemoryKvStore();
}

describe("normalizeErrorPage (privacy boundary)", () => {
  test("strips query strings and fragments", () => {
    expect(normalizeErrorPage("/builder?draft=brandon")).toBe("/builder");
    expect(normalizeErrorPage("/brandon#guestbook")).toBe("/brandon");
    expect(normalizeErrorPage("/page?a=1&token=secret#x")).toBe("/page");
  });
  test("requires a leading slash", () => {
    expect(normalizeErrorPage("builder")).toBeNull();
    expect(normalizeErrorPage("")).toBeNull();
    expect(normalizeErrorPage("https://evil.com/x")).toBeNull();
  });
  test("caps length and rejects non-strings", () => {
    expect(normalizeErrorPage("/" + "a".repeat(500))).not.toBeNull();
    expect(normalizeErrorPage("/" + "a".repeat(500))!.length).toBeLessThanOrEqual(120);
    expect(normalizeErrorPage(null)).toBeNull();
    expect(normalizeErrorPage(42)).toBeNull();
  });
  test("keeps normal paths intact", () => {
    expect(normalizeErrorPage("/")).toBe("/");
    expect(normalizeErrorPage("/builder")).toBe("/builder");
    expect(normalizeErrorPage("/townhall/post/123")).toBe("/townhall/post/123");
  });
});

describe("scrubErrorMessage / normalizeErrorMessage", () => {
  test("scrubs EVM addresses and Hedera account IDs", () => {
    expect(scrubErrorMessage("failed for 0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58")).toBe(
      "failed for 0x…",
    );
    expect(scrubErrorMessage("account 0.0.10424063 not found")).toBe("account 0.0.… not found");
    expect(scrubErrorMessage("plain message")).toBe("plain message");
  });
  test("scrubs email addresses and phone numbers", () => {
    expect(scrubErrorMessage("contact john@example.com for help")).toBe("contact …@… for help");
    expect(scrubErrorMessage("call 555-123-4567 now")).toBe("call …phone… now");
    expect(scrubErrorMessage("call +1 (555) 123-4567 now")).toBe("call …phone… now");
    // Plain digit runs (order numbers) are left alone
    expect(scrubErrorMessage("order 12345 shipped")).toBe("order 12345 shipped");
  });
  test("truncates to 200 chars and collapses whitespace", () => {
    const long = "x".repeat(500);
    expect(normalizeErrorMessage(long)!.length).toBe(MAX_ERROR_MESSAGE_LEN);
    expect(normalizeErrorMessage("a\n\n  b\tc")).toBe("a b c");
  });
  test("scrubs before storing (via normalizeErrorMessage)", () => {
    const msg = normalizeErrorMessage("revert 0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58 broke");
    expect(msg).not.toContain("0xd87F");
    expect(msg).toContain("0x…");
  });
  test("empty / non-string → null", () => {
    expect(normalizeErrorMessage("")).toBeNull();
    expect(normalizeErrorMessage("   ")).toBeNull();
    expect(normalizeErrorMessage(null)).toBeNull();
  });
});

describe("normalizeErrorComponent", () => {
  test("slugifies, null when unusable", () => {
    expect(normalizeErrorComponent("PublishButton")).toBe("publishbutton");
    expect(normalizeErrorComponent("my comp!")).toBe("mycomp");
    expect(normalizeErrorComponent("")).toBeNull();
    expect(normalizeErrorComponent(null)).toBeNull();
  });
});

describe("hashErrorMessage", () => {
  test("deterministic and sensitive to input", () => {
    expect(hashErrorMessage("boom")).toBe(hashErrorMessage("boom"));
    expect(hashErrorMessage("boom")).not.toBe(hashErrorMessage("bam"));
    expect(hashErrorMessage("x")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("slugifyErrorPage", () => {
  test("produces key-safe slugs", () => {
    expect(slugifyErrorPage("/")).toBe("root");
    expect(slugifyErrorPage("/builder")).toBe("builder");
    expect(slugifyErrorPage("/townhall/post/1")).toBe("townhall-post-1");
  });
});

describe("recordClientError", () => {
  test("aggregates identical reports and tracks first/last seen", async () => {
    const store = mem();
    const t0 = Date.UTC(2026, 8, 11, 12, 0, 0);
    await recordClientError(store, "/builder", "chunk failed", null, null, t0);
    await recordClientError(store, "/builder", "chunk failed", null, null, t0 + 1000);
    const date = errorDateKey(new Date(t0));
    const key = errorAggKey(date, "/builder", hashErrorMessage("/builder||chunk failed|"));
    const raw = await store.get(key);
    expect(raw).not.toBeNull();
    const agg = JSON.parse(raw!) as { count: number; firstSeen: number; lastSeen: number };
    expect(agg.count).toBe(2);
    expect(agg.firstSeen).toBe(t0);
    expect(agg.lastSeen).toBe(t0 + 1000);
  });

  test("separate buckets per page/message/component", async () => {
    const store = mem();
    const t0 = Date.UTC(2026, 8, 11, 12, 0, 0);
    await recordClientError(store, "/a", "boom", null, null, t0);
    await recordClientError(store, "/b", "boom", null, null, t0);
    await recordClientError(store, "/a", "bam", null, null, t0);
    const date = errorDateKey(new Date(t0));
    const idx = JSON.parse((await store.get(errorIndexKey(date)))!) as string[];
    expect(idx).toHaveLength(3);
  });

  test("invalid input is dropped (returns false)", async () => {
    const store = mem();
    expect(await recordClientError(store, "nope", "boom")).toBe(false);
    expect(await recordClientError(store, "/a", "")).toBe(false);
  });

  test("stored aggregate contains no PII fields", async () => {
    const store = mem();
    const t0 = Date.UTC(2026, 8, 11, 12, 0, 0);
    await recordClientError(store, "/builder?token=secret", "fail 0.0.10424063", "Btn", null, t0);
    const date = errorDateKey(new Date(t0));
    const keys = JSON.parse((await store.get(errorIndexKey(date)))!) as string[];
    const agg = JSON.parse((await store.get(keys[0]))!) as Record<string, unknown>;
    expect(Object.keys(agg).sort()).toEqual(
      ["component", "count", "firstSeen", "frame", "lastSeen", "message", "page", "spikeAlerted"].sort(),
    );
    expect(agg.page).toBe("/builder"); // query stripped
    expect(agg.message).not.toContain("0.0.10424063"); // scrubbed
    const serialized = JSON.stringify(agg);
    expect(serialized).not.toMatch(/\d+\.\d+\.\d+/);
  });

  test("never throws on a broken store", async () => {
    const broken: KvStore = {
      incr: async () => { throw new Error("down"); },
      setNx: async () => { throw new Error("down"); },
      set: async () => { throw new Error("down"); },
      get: async () => { throw new Error("down"); },
      del: async () => { throw new Error("down"); },
      clearPrefix: async () => { throw new Error("down"); },
    };
    await expect(recordClientError(broken, "/a", "boom")).resolves.toBe(false);
  });

  test("normalizeErrorFrame scrubs identifiers, caps length, nulls junk", () => {
    expect(normalizeErrorFrame(null)).toBeNull();
    expect(normalizeErrorFrame(123)).toBeNull();
    expect(normalizeErrorFrame("")).toBeNull();
    expect(normalizeErrorFrame("at tip (c.js:1:2) for 0.0.10424063")).toBe(
      "at tip (c.js:1:2) for 0.0.…",
    );
    const long = "at " + "f".repeat(200) + " (c.js:1:2)";
    expect(normalizeErrorFrame(long)!.length).toBeLessThanOrEqual(120);
  });

  test("first frame is stored and distinguishes otherwise-identical buckets", async () => {
    const store = mem();
    const t0 = Date.UTC(2026, 8, 11, 12, 0, 0);
    const msg = "Cannot read properties of undefined (reading 'call')";
    await recordClientError(store, "/", msg, null, "at a (x.js:1:1)", t0);
    await recordClientError(store, "/", msg, null, "at b (y.js:2:2)", t0);
    await recordClientError(store, "/", msg, null, "at a (x.js:1:1)", t0);
    const date = errorDateKey(new Date(t0));
    const idx = JSON.parse((await store.get(errorIndexKey(date)))!) as string[];
    expect(idx).toHaveLength(2); // two frames → two aggregates
    const aggs = await getErrorAggregates(store, ERROR_STATS_DAY_COUNT, t0);
    const counts = Object.fromEntries(aggs.map((a) => [a.frame, a.count]));
    expect(counts).toEqual({ "at a (x.js:1:1)": 2, "at b (y.js:2:2)": 1 });
  });

  test("error spike emits exactly one [error-spike] log per aggregate per day", async () => {
    const store = mem();
    const t0 = Date.UTC(2026, 8, 11, 12, 0, 0);
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => void warnings.push(m);
    try {
      for (let i = 0; i < ERROR_SPIKE_THRESHOLD + 3; i++) {
        await recordClientError(store, "/x", "spike-me", null, null, t0 + i);
      }
      const spikes = warnings.filter((w) => w.startsWith("[error-spike]"));
      expect(spikes).toHaveLength(1);
      expect(spikes[0]).toContain("spike-me");
      expect(spikes[0]).toContain(String(ERROR_SPIKE_THRESHOLD));
    } finally {
      console.warn = orig;
    }
  });

  test("no spike log below the threshold", async () => {
    const store = mem();
    const t0 = Date.UTC(2026, 8, 11, 12, 0, 0);
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => void warnings.push(m);
    try {
      for (let i = 0; i < ERROR_SPIKE_THRESHOLD - 1; i++) {
        await recordClientError(store, "/x", "quiet", null, null, t0 + i);
      }
      expect(warnings.filter((w) => w.startsWith("[error-spike]"))).toHaveLength(0);
    } finally {
      console.warn = orig;
    }
  });
});

describe("getErrorAggregates", () => {
  test("returns last-7-day aggregates sorted by count desc", async () => {
    const store = mem();
    const t0 = Date.UTC(2026, 8, 11, 12, 0, 0);
    await recordClientError(store, "/a", "rare", null, null, t0);
    await recordClientError(store, "/b", "common", null, null, t0);
    await recordClientError(store, "/b", "common", null, null, t0);
    await recordClientError(store, "/b", "common", null, null, t0);
    // Old report (8 days ago) should be excluded.
    await recordClientError(store, "/old", "ancient", null, null, t0 - 8 * 86400_000);
    const aggs = await getErrorAggregates(store, ERROR_STATS_DAY_COUNT, t0);
    expect(aggs.map((a) => a.message)).toEqual(["common", "rare"]);
    expect(aggs[0].count).toBe(3);
    expect(aggs[0].page).toBe("/b");
  });
});

describe("founder gate", () => {
  const env = {
    FOUNDER_WALLETS: "0.0.10424063, 0xABCdef1234567890",
  };
  test("founderWallets always includes the founder + env extras", () => {
    expect(founderWallets(env)).toEqual(["0.0.10424063", "0xabcdef1234567890"]);
    expect(founderWallets({})).toEqual(["0.0.10424063"]);
  });
  test("isFounderWallet is case-insensitive", () => {
    expect(isFounderWallet("0.0.10424063", env)).toBe(true);
    expect(isFounderWallet("0xABCDEF1234567890", env)).toBe(true);
    // Long-zero EVM form of the founder account resolves too.
    expect(isFounderWallet("0x00000000000000000000000000000000009f0eff", env)).toBe(true);
    expect(isFounderWallet("0.0.1", env)).toBe(false);
    expect(isFounderWallet(null, env)).toBe(false);
  });
});

describe("getClientErrorStats (admin gate)", () => {
  const env = { NEXT_PUBLIC_TREASURY_ADDRESS: "0.0.10424063" };
  function deps(over: Record<string, unknown> = {}) {
    return {
      store: mem(),
      verifySession: async () => ({ ok: true as const, address: "0.0.10424063" }),
      env,
      ...over,
    };
  }
  test("401 without credential", async () => {
    const res = await getClientErrorStats(deps(), null);
    expect(res.status).toBe(401);
  });
  test("401 on bad session", async () => {
    const res = await getClientErrorStats(
      deps({ verifySession: async () => ({ ok: false as const, error: "bad token" }) }),
      "token",
    );
    expect(res.status).toBe(401);
  });
  test("403 for non-founder wallet", async () => {
    const res = await getClientErrorStats(
      deps({ verifySession: async () => ({ ok: true as const, address: "0.0.12345" }) }),
      "token",
    );
    expect(res.status).toBe(403);
  });
  test("200 with aggregates for founder wallet", async () => {
    const d = deps();
    await recordClientError(d.store, "/builder", "boom");
    const res = await getClientErrorStats(d, "token");
    expect(res.status).toBe(200);
    const json = res.json as { errors: { message: string; count: number }[]; days: number };
    expect(json.days).toBe(ERROR_STATS_DAY_COUNT);
    expect(json.errors).toHaveLength(1);
    expect(json.errors[0].message).toBe("boom");
  });
  test("TTL is 7 days", () => {
    expect(CLIENT_ERROR_TTL_MS).toBe(7 * 24 * 3600 * 1000);
  });
});
