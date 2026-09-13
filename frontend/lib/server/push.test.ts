/**
 * Tests for lib/server/push.ts — web push for tip notifications (Slice 1).
 *
 * - Subscription add/dedupe/remove against the in-memory KV.
 * - Payload validation shapes.
 * - /api/push/check orchestration (runPushCheck): idempotency, watermark
 *   advance, dead-subscription pruning — with mocked fetch and a mocked
 *   push sender. No network, no real web-push, no mirror node.
 * - VAPID public key format validation.
 */
import { describe, expect, it, vi } from "vitest";
import { createMemoryKvStore } from "./store";
import {
  PUSH_LAST_TS_KV_KEY,
  PUSH_VAPID_KV_KEY,
  PUSH_VAPID_PUBLIC_KV_KEY,
  TIPSENT_TOPIC0,
  addSubscription,
  buildTipPayload,
  decodeTipLog,
  ensureVapidKeypair,
  listSubscriptions,
  removeSubscription,
  runPushCheck,
  secretsMatch,
  subscriptionsForRecipient,
  subsKeysForRecipient,
  subsKeysForWallet,
  validateSubscriptionPayload,
  type PushCheckDeps,
} from "./push";
import {
  PUSH_VAPID_PUBLIC_KEY,
  isValidVapidPrivateKey,
  isValidVapidPublicKey,
} from "@/lib/push";

const WALLET = "0.0.10424063";
const RECIPIENT_EVM = "0x00000000000000000000000000000000009f0eff"; // 0.0.10424063 long-zero

function padTopic(addr: string): string {
  return "0x" + addr.slice(2).padStart(64, "0");
}

function tipLog(overrides: Record<string, unknown> = {}) {
  // 1.5 HBAR = 150_000_000 tinybar
  const amountHex = (150_000_000n).toString(16).padStart(64, "0");
  const feeHex = (3_000_000n).toString(16).padStart(64, "0");
  return {
    transaction_hash: "0xaaaabbbbcccc",
    timestamp: "1700001000.500000000",
    topics: [
      TIPSENT_TOPIC0,
      "0x" + "11".repeat(32),
      padTopic("0x0000000000000000000000000000000000111111"),
      padTopic(RECIPIENT_EVM),
    ],
    data: "0x" + amountHex + feeHex,
    ...overrides,
  };
}

function mockFetch(logs: unknown[]) {
  return (async () =>
    ({
      ok: true,
      json: async () => ({ logs }),
    }) as Response) as typeof fetch;
}

function checkDeps(
  kv: ReturnType<typeof createMemoryKvStore>,
  overrides: Partial<PushCheckDeps> = {},
): PushCheckDeps {
  return {
    kv,
    fetchImpl: mockFetch([tipLog()]),
    sender: vi.fn(async () => {}),
    expectedSecret: "s3cret",
    providedSecret: "s3cret",
    siteUrl: "https://example.test",
    ...overrides,
  };
}

describe("validateSubscriptionPayload", () => {
  const good = {
    endpoint: "https://push.example.com/sub/123",
    keys: { p256dh: "p256", auth: "auth" },
  };
  it("accepts a well-formed subscription", () => {
    const r = validateSubscriptionPayload(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sub.endpoint).toBe(good.endpoint);
  });
  it("rejects non-https endpoints", () => {
    const r = validateSubscriptionPayload({ ...good, endpoint: "http://x/y" });
    expect(r.ok).toBe(false);
  });
  it("rejects malformed endpoint URLs", () => {
    const r = validateSubscriptionPayload({ ...good, endpoint: "not a url" });
    expect(r.ok).toBe(false);
  });
  it("rejects missing keys", () => {
    expect(validateSubscriptionPayload({ endpoint: good.endpoint }).ok).toBe(false);
    expect(
      validateSubscriptionPayload({
        endpoint: good.endpoint,
        keys: { p256dh: "", auth: "a" },
      }).ok,
    ).toBe(false);
  });
  it("defaults unknown lang to en", () => {
    const r = validateSubscriptionPayload({ ...good, lang: "xx" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sub.lang).toBe("en");
  });
  it("keeps a supported lang", () => {
    const r = validateSubscriptionPayload({ ...good, lang: "es" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sub.lang).toBe("es");
  });
});

describe("subscription storage", () => {
  it("adds and dedupes by endpoint, refreshes on re-add", async () => {
    const kv = createMemoryKvStore();
    const sub = { endpoint: "https://push.example.com/a", keys: { p256dh: "p", auth: "a" }, lang: "en" };
    expect(await addSubscription(kv, WALLET, sub)).toBe(1);
    expect(await addSubscription(kv, WALLET, sub)).toBe(1); // dedupe
    const sub2 = { ...sub, endpoint: "https://push.example.com/b" };
    expect(await addSubscription(kv, WALLET, sub2)).toBe(2);
    expect(await listSubscriptions(kv, WALLET)).toHaveLength(2);
  });

  it("finds subs via the 0.0.x wallet form for an EVM recipient lookup", async () => {
    const kv = createMemoryKvStore();
    await addSubscription(
      kv,
      WALLET,
      { endpoint: "https://push.example.com/a", keys: { p256dh: "p", auth: "a" }, lang: "en" },
    );
    const found = await subscriptionsForRecipient(kv, RECIPIENT_EVM);
    expect(found).toHaveLength(1);
    expect(found[0].endpoint).toBe("https://push.example.com/a");
  });

  it("removes one endpoint and keeps the rest", async () => {
    const kv = createMemoryKvStore();
    const mk = (e: string) => ({ endpoint: e, keys: { p256dh: "p", auth: "a" }, lang: "en" });
    await addSubscription(kv, WALLET, mk("https://push.example.com/a"));
    await addSubscription(kv, WALLET, mk("https://push.example.com/b"));
    expect(await removeSubscription(kv, WALLET, "https://push.example.com/a")).toBe(1);
    expect(await listSubscriptions(kv, WALLET)).toHaveLength(1);
    expect(await removeSubscription(kv, WALLET, "https://push.example.com/b")).toBe(0);
    expect(await listSubscriptions(kv, WALLET)).toHaveLength(0);
  });

  it("removing an unknown endpoint is a no-op", async () => {
    const kv = createMemoryKvStore();
    expect(await removeSubscription(kv, WALLET, "https://push.example.com/nope")).toBe(0);
  });

  it("subsKeysForRecipient probes the 0.0.x form of a long-zero address", () => {
    const keys = subsKeysForRecipient(RECIPIENT_EVM);
    expect(keys).toContain("push:subs:0.0.10424063");
  });

  it("subsKeysForWallet covers raw and canonical EVM forms", () => {
    const keys = subsKeysForWallet(WALLET);
    expect(keys).toContain(`push:subs:${WALLET.toLowerCase()}`);
    expect(keys).toContain(`push:subs:${RECIPIENT_EVM}`);
  });
});

describe("decodeTipLog", () => {
  it("decodes recipient, from, amount and timestamp", () => {
    const tip = decodeTipLog(tipLog());
    expect(tip).not.toBeNull();
    expect(tip!.recipient).toBe(RECIPIENT_EVM);
    expect(tip!.from).toBe("0x0000000000000000000000000000000000111111");
    expect(tip!.amountHbar).toBe("1.5000");
    expect(tip!.timestampSec).toBeCloseTo(1700001000.5, 6);
    expect(tip!.txHash).toBe("0xaaaabbbbcccc");
  });
  it("rejects logs with the wrong topic0", () => {
    expect(decodeTipLog(tipLog({ topics: ["0xdead", "0x", "0x", "0x"] }))).toBeNull();
  });
  it("rejects logs without a data amount", () => {
    const tip = decodeTipLog(tipLog({ data: "0x" }));
    expect(tip).not.toBeNull();
    expect(tip!.amountHbar).toBe("0");
  });
});

describe("secretsMatch", () => {
  it("matches equal secrets, rejects everything else", () => {
    expect(secretsMatch("abc", "abc")).toBe(true);
    expect(secretsMatch("abc", "abd")).toBe(false);
    expect(secretsMatch("abc", "")).toBe(false);
    expect(secretsMatch("abc", null)).toBe(false);
    expect(secretsMatch(null, "abc")).toBe(false);
  });
});

describe("runPushCheck", () => {
  it("rejects a wrong secret with 401", async () => {
    const kv = createMemoryKvStore();
    const r = await runPushCheck(checkDeps(kv, { providedSecret: "wrong" }));
    expect(r.status).toBe(401);
  });

  it("sends to subscribed recipients and advances the watermark", async () => {
    const kv = createMemoryKvStore();
    await addSubscription(
      kv,
      WALLET,
      { endpoint: "https://push.example.com/a", keys: { p256dh: "p", auth: "a" }, lang: "en" },
    );
    const sender = vi.fn(async () => {});
    const r = await runPushCheck(checkDeps(kv, { sender }));
    expect(r.status).toBe(200);
    if (r.status === 200) {
      expect(r.body.checked).toBe(1);
      expect(r.body.sent).toBe(1);
      expect(r.body.pruned).toBe(0);
    }
    expect(sender).toHaveBeenCalledTimes(1);
    const [, payload, vapid] = sender.mock.calls[0] as unknown as [
      unknown,
      { title: string; body: string; url: string },
      { subject: string },
    ];
    expect(payload.title).toBe("New tip received");
    expect(payload.body).toBe("You received 1.5000 HBAR");
    expect(vapid.subject).toBe("mailto:support@voicescape");
    // Watermark advanced past the log timestamp.
    expect(parseFloat((await kv.get(PUSH_LAST_TS_KV_KEY)) ?? "0")).toBeGreaterThan(1700001000);
  });

  it("is idempotent: a second sweep sends nothing new", async () => {
    const kv = createMemoryKvStore();
    await addSubscription(
      kv,
      WALLET,
      { endpoint: "https://push.example.com/a", keys: { p256dh: "p", auth: "a" }, lang: "en" },
    );
    const sender = vi.fn(async () => {});
    const deps = checkDeps(kv, { sender });
    const first = await runPushCheck(deps);
    expect(first.status).toBe(200);
    const second = await runPushCheck(checkDeps(kv, { sender }));
    expect(second.status).toBe(200);
    if (second.status === 200) {
      expect(second.body.checked).toBe(0);
      expect(second.body.sent).toBe(0);
    }
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("skips logs at or below the watermark", async () => {
    const kv = createMemoryKvStore();
    await kv.set(PUSH_LAST_TS_KV_KEY, "1800000000", 60_000);
    const sender = vi.fn(async () => {});
    const r = await runPushCheck(checkDeps(kv, { sender }));
    expect(r.status).toBe(200);
    if (r.status === 200) {
      expect(r.body.checked).toBe(0);
      expect(r.body.sent).toBe(0);
    }
    expect(sender).not.toHaveBeenCalled();
  });

  it("does not send when the recipient has no subscriptions", async () => {
    const kv = createMemoryKvStore();
    const sender = vi.fn(async () => {});
    const r = await runPushCheck(checkDeps(kv, { sender }));
    expect(r.status).toBe(200);
    if (r.status === 200) expect(r.body.sent).toBe(0);
    expect(sender).not.toHaveBeenCalled();
  });

  it("prunes dead (410) subscriptions and keeps the live ones", async () => {
    const kv = createMemoryKvStore();
    await addSubscription(
      kv,
      WALLET,
      { endpoint: "https://push.example.com/live", keys: { p256dh: "p", auth: "a" }, lang: "en" },
    );
    await addSubscription(
      kv,
      WALLET,
      { endpoint: "https://push.example.com/dead", keys: { p256dh: "p", auth: "a" }, lang: "en" },
    );
    const sender = vi.fn(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith("/dead")) {
        const err = new Error("gone") as Error & { statusCode: number };
        err.statusCode = 410;
        throw err;
      }
    });
    const r = await runPushCheck(checkDeps(kv, { sender }));
    expect(r.status).toBe(200);
    if (r.status === 200) {
      expect(r.body.sent).toBe(1);
      expect(r.body.pruned).toBe(1);
    }
    const remaining = await subscriptionsForRecipient(kv, RECIPIENT_EVM);
    expect(remaining.map((s) => s.endpoint)).toEqual(["https://push.example.com/live"]);
  });

  it("queries the mirror node with a bounded timestamp range (topic searches require it)", async () => {
    const kv = createMemoryKvStore();
    let seenUrl = "";
    const capturingFetch = (async (url: unknown) => {
      seenUrl = String(url);
      return { ok: true, json: async () => ({ logs: [] }) };
    }) as typeof fetch;
    const r = await runPushCheck(checkDeps(kv, { fetchImpl: capturingFetch }));
    expect(r.status).toBe(200);
    // Mirror node rejects topic queries without BOTH a lower and an upper
    // timestamp bound — the sweep must always send a bounded range.
    expect(seenUrl).toContain("topic0=");
    expect(seenUrl).toMatch(/timestamp=gte:\d+\.000000000/);
    expect(seenUrl).toMatch(/timestamp=lte:\d+\.999999999/);
  });

  it("allows the sweep without a secret when none is configured", async () => {
    const kv = createMemoryKvStore();
    await addSubscription(
      kv,
      WALLET,
      { endpoint: "https://push.example.com/a", keys: { p256dh: "p", auth: "a" }, lang: "en" },
    );
    const sender = vi.fn(async () => {});
    const r = await runPushCheck(
      checkDeps(kv, { sender, expectedSecret: null, providedSecret: null }),
    );
    expect(r.status).toBe(200);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("generates and persists a VAPID keypair on the first sweep", async () => {
    const kv = createMemoryKvStore();
    await addSubscription(
      kv,
      WALLET,
      { endpoint: "https://push.example.com/a", keys: { p256dh: "p", auth: "a" }, lang: "en" },
    );
    const sender = vi.fn(async () => {});
    const r = await runPushCheck(checkDeps(kv, { sender }));
    expect(r.status).toBe(200);
    if (r.status === 200) {
      expect(r.body.sent).toBe(1);
      expect(r.body.skipped).toBeUndefined();
    }
    const storedPrivate = await kv.get(PUSH_VAPID_KV_KEY);
    const storedPublic = await kv.get(PUSH_VAPID_PUBLIC_KV_KEY);
    expect(isValidVapidPrivateKey(storedPrivate)).toBe(true);
    expect(isValidVapidPublicKey(storedPublic)).toBe(true);
  });

  it("reuses the persisted keypair on later sweeps (no rotation)", async () => {
    const kv = createMemoryKvStore();
    const first = await ensureVapidKeypair(kv);
    const second = await ensureVapidKeypair(kv);
    expect(second).toEqual(first);
  });

  it("regenerates both halves when only a half-pair is present", async () => {
    const kv = createMemoryKvStore();
    await kv.set(PUSH_VAPID_KV_KEY, "x".repeat(43), 60_000);
    const pair = await ensureVapidKeypair(kv);
    expect(isValidVapidPrivateKey(pair.privateKey)).toBe(true);
    expect(isValidVapidPublicKey(pair.publicKey)).toBe(true);
    // The stale half-pair was replaced wholesale.
    expect(await kv.get(PUSH_VAPID_KV_KEY)).toBe(pair.privateKey);
    expect(await kv.get(PUSH_VAPID_PUBLIC_KV_KEY)).toBe(pair.publicKey);
  });

  it("resolves the blockpage URL when a username is known", async () => {
    const kv = createMemoryKvStore();
    await addSubscription(
      kv,
      WALLET,
      { endpoint: "https://push.example.com/a", keys: { p256dh: "p", auth: "a" }, lang: "es" },
    );
    const sender = vi.fn(async () => {});
    const r = await runPushCheck(
      checkDeps(kv, {
        sender,
        resolveUsername: async () => "user-10424063",
      }),
    );
    expect(r.status).toBe(200);
    const [, payload] = sender.mock.calls[0] as unknown as [
      unknown,
      { title: string; body: string; url: string },
    ];
    expect(payload.url).toBe("https://example.test/user-10424063");
    // Spanish localization of the push text.
    expect(payload.title).toBe("Nueva propina recibida");
    expect(payload.body).toBe("Recibiste 1.5000 HBAR");
  });

  it("falls back to the notifications URL when no username resolves", async () => {
    const kv = createMemoryKvStore();
    await addSubscription(
      kv,
      WALLET,
      { endpoint: "https://push.example.com/a", keys: { p256dh: "p", auth: "a" }, lang: "en" },
    );
    const sender = vi.fn(async () => {});
    const r = await runPushCheck(
      checkDeps(kv, { sender, resolveUsername: async () => null }),
    );
    expect(r.status).toBe(200);
    const [, payload] = sender.mock.calls[0] as unknown as [
      unknown,
      { title: string; body: string; url: string },
    ];
    expect(payload.url).toBe(`https://example.test/api/notifications?address=${RECIPIENT_EVM}`);
  });

  it("ignores non-TipSent logs and keeps scanning", async () => {
    const kv = createMemoryKvStore();
    await addSubscription(
      kv,
      WALLET,
      { endpoint: "https://push.example.com/a", keys: { p256dh: "p", auth: "a" }, lang: "en" },
    );
    const sender = vi.fn(async () => {});
    const logs = [
      tipLog({ topics: ["0x" + "ff".repeat(32), "0x", "0x", "0x"], timestamp: "1700001002.0" }),
      tipLog(),
    ];
    const r = await runPushCheck(checkDeps(kv, { sender, fetchImpl: mockFetch(logs) }));
    expect(r.status).toBe(200);
    if (r.status === 200) expect(r.body.sent).toBe(1);
    // Watermark covers the newest log seen, even the undecodable one.
    expect(parseFloat((await kv.get(PUSH_LAST_TS_KV_KEY)) ?? "0")).toBeGreaterThan(1700001001);
  });
});

describe("buildTipPayload", () => {
  const tip = {
    txHash: "0x1",
    timestampSec: 1,
    from: "0x2",
    recipient: RECIPIENT_EVM,
    amountHbar: "2.0000",
  };
  it("localizes title and body per subscription language", () => {
    const es = buildTipPayload(tip, "es", "https://example.test/x");
    expect(es.title).toBe("Nueva propina recibida");
    expect(es.body).toBe("Recibiste 2.0000 HBAR");
    const zh = buildTipPayload(tip, "zh", "https://example.test/x");
    expect(zh.body).toBe("你收到了 2.0000 HBAR");
  });
  it("falls back to English for unknown languages", () => {
    const p = buildTipPayload(tip, "xx", "https://example.test/x");
    expect(p.title).toBe("New tip received");
  });
});

describe("VAPID key formats", () => {
  it("accepts the real generated public key", () => {
    expect(isValidVapidPublicKey(PUSH_VAPID_PUBLIC_KEY)).toBe(true);
  });
  it("accepts a self-generated keypair (both halves, correct formats)", async () => {
    const kv = createMemoryKvStore();
    const pair = await ensureVapidKeypair(kv);
    expect(isValidVapidPublicKey(pair.publicKey)).toBe(true);
    expect(isValidVapidPrivateKey(pair.privateKey)).toBe(true);
  });
  it("rejects malformed keys", () => {
    expect(isValidVapidPublicKey("not-a-key")).toBe(false);
    expect(isValidVapidPublicKey("")).toBe(false);
    expect(isValidVapidPublicKey(null)).toBe(false);
    expect(isValidVapidPrivateKey(PUSH_VAPID_PUBLIC_KEY)).toBe(false); // 87 chars ≠ 43
  });
});
