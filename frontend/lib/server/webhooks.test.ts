/**
 * webhooks lib tests: URL/SSRF validation, HMAC round-trip, cursor string
 * handling, log decoding, subscription storage, dispatch dedupe + guards.
 *
 * The KV store is the real in-memory backend, cleared between tests.
 * No network: fetch and DNS are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import { getKvStore } from "@/lib/server/store";
import {
  PURCHASE_TOPIC,
  TIPSENT_TOPIC,
  createSubscription,
  decodeLog,
  deleteSubscription,
  dispatchToSubscription,
  hostnameAllowed,
  ipAllowed,
  listSubscriptions,
  maxTimestamp,
  normalizeEvents,
  pollAndDispatch,
  signDelivery,
  validateWebhookUrl,
  verifyDeliverySignature,
  defaultWebhookDeps,
  type WebhookDeps,
  type WebhookSubscription,
} from "./webhooks";

const DURABLE_TTL = 10 * 365 * 24 * 3600 * 1000;

function deps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    ...defaultWebhookDeps(),
    store: getKvStore(),
    verifySession: async () => ({ ok: false, error: "no" }),
    resolvePageOwner: async () => "somepage",
    mirrorBase: () => "https://mirror.test",
    tipsContract: () => "0.0.99999",
    resolveHost: async () => ["93.184.216.34"],
    nowMs: () => 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(async () => {
  await getKvStore().clearPrefix("webhook:");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------- URL validation ---------------- */

describe("validateWebhookUrl", () => {
  it("accepts a plain public https URL", () => {
    const r = validateWebhookUrl("https://hooks.example.com/voicescape");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://hooks.example.com/voicescape");
  });

  it.each([
    "http://hooks.example.com/x", // not https
    "https://localhost/x",
    "https://localhost:8443/x",
    "https://127.0.0.1/x",
    "https://10.0.0.5/x",
    "https://172.16.4.4/x",
    "https://192.168.1.1/x",
    "https://169.254.169.254/latest", // cloud metadata
    "https://[::1]/x",
    "https://user:pass@hooks.example.com/x", // credentials
    "https://hooks.example.com:8443/x", // non-443 port
    "https://myhost.local/x",
    "https://myhost.internal/x",
    "not a url",
    "",
  ])("rejects %s", (raw) => {
    expect(validateWebhookUrl(raw).ok).toBe(false);
  });

  it("accepts a public IP literal", () => {
    expect(validateWebhookUrl("https://93.184.216.34/x").ok).toBe(true);
  });
});

describe("ipAllowed / hostnameAllowed", () => {
  it.each(["10.1.2.3", "172.31.255.255", "192.168.0.1", "127.0.0.1", "0.0.0.0", "169.254.10.20"])(
    "rejects private v4 %s",
    (ip) => expect(ipAllowed(ip)).toBe(false),
  );
  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34"])("allows public v4 %s", (ip) =>
    expect(ipAllowed(ip)).toBe(true),
  );
  it("rejects v6 loopback/link-local/unique-local", () => {
    expect(ipAllowed("::1")).toBe(false);
    expect(ipAllowed("fe80::1")).toBe(false);
    expect(ipAllowed("fc00::1")).toBe(false);
  });
  it("rejects localhost-ish names without DNS", () => {
    expect(hostnameAllowed("localhost")).toBe(false);
    expect(hostnameAllowed("x.local")).toBe(false);
    expect(hostnameAllowed("")).toBe(false);
  });
});

/* ---------------- HMAC ---------------- */

describe("delivery signatures", () => {
  const secret = "ab".repeat(32);
  const body = JSON.stringify({ event: "tip" });

  it("round-trips", () => {
    const sig = signDelivery(secret, body);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDeliverySignature(secret, body, sig)).toBe(true);
  });

  it("rejects tampered bodies and malformed signatures", () => {
    const sig = signDelivery(secret, body);
    expect(verifyDeliverySignature(secret, body + "x", sig)).toBe(false);
    expect(verifyDeliverySignature("cd".repeat(32), body, sig)).toBe(false);
    expect(verifyDeliverySignature(secret, body, "not-hex")).toBe(false);
    expect(verifyDeliverySignature(secret, body, "")).toBe(false);
  });
});

/* ---------------- cursor ---------------- */

describe("maxTimestamp", () => {
  it("compares as exact strings, never floats", () => {
    // The float trap from the mirror-node lesson: parseFloat would round
    // the first value down and re-fetch forever.
    expect(maxTimestamp("1789520539.844492534", "1789520539.8444924")).toBe("1789520539.844492534");
    expect(maxTimestamp("99.999999999", "100.000000000")).toBe("100.000000000");
    // Decimal-correct: 100.5s (500ms) is later than 100.15s (150ms).
    expect(maxTimestamp("100.5", "100.15")).toBe("100.5");
    expect(maxTimestamp("100.15", "100.15")).toBe("100.15");
  });
});

/* ---------------- log decoding ---------------- */

const TIPS = new ethers.Interface([
  "event TipSent(string indexed username, address indexed from, address indexed toOwner, uint256 amount, uint256 fee)",
]);
const SALE = new ethers.Interface([
  "event PurchaseCompleted(address indexed buyer, address indexed seller, string listingRef, uint256 amount, uint256 fee)",
]);

const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";

function tipLog(ts: string) {
  const { topics, data } = TIPS.encodeEventLog("TipSent", ["someuser", FROM, TO, 500_000_000n, 10_000_000n]);
  return { topics, data, timestamp: ts, transaction_hash: "0xhash1" };
}
function saleLog(ts: string) {
  const { topics, data } = SALE.encodeEventLog("PurchaseCompleted", [FROM, TO, "listing-1", 2_000_000_000n, 40_000_000n]);
  return { topics, data, timestamp: ts, transaction_hash: "0xhash2" };
}

describe("decodeLog", () => {
  it("decodes a TipSent log", () => {
    const e = decodeLog(tipLog("1790000000.000000001"));
    expect(e).toMatchObject({
      event: "tip",
      from: FROM,
      to: TO,
      amountTinybar: "500000000",
      timestamp: "1790000000.000000001",
      txId: "0xhash1",
    });
  });

  it("decodes a PurchaseCompleted log (seller is the recipient)", () => {
    const e = decodeLog(saleLog("1790000000.000000002"));
    expect(e).toMatchObject({ event: "purchase", from: FROM, to: TO, amountTinybar: "2000000000" });
  });

  it("ignores unknown topics and malformed logs", () => {
    expect(decodeLog({ topics: ["0xdead"], data: "0x", timestamp: "1.0", transaction_hash: "0xh" })).toBeNull();
    expect(decodeLog({ topics: [], data: "0x" })).toBeNull();
  });

  it("topic constants match the canonical event hashes", () => {
    expect(TIPSENT_TOPIC).toBe("0xddb557901a5c7e767f2276c1190ca61ae148d62a74cfa61e4f7fa5319eaa431e");
    expect(PURCHASE_TOPIC).toBe(SALE.getEvent("PurchaseCompleted")!.topicHash.toLowerCase());
  });
});

describe("normalizeEvents", () => {
  it("accepts tip/purchase subsets, dedupes", () => {
    expect(normalizeEvents(["tip"])).toEqual(["tip"]);
    expect(normalizeEvents(["purchase", "tip", "tip"])).toEqual(["purchase", "tip"]);
  });
  it("rejects garbage", () => {
    expect(normalizeEvents([])).toBeNull();
    expect(normalizeEvents(["tip", "bogus"])).toBeNull();
    expect(normalizeEvents("tip")).toBeNull();
  });
});

/* ---------------- subscriptions ---------------- */

describe("subscription storage", () => {
  const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("creates, lists (no secret), and deletes", async () => {
    const d = deps();
    const created = await createSubscription(d, OWNER, "https://hooks.example.com/ev", ["tip", "purchase"]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);

    const listed = await listSubscriptions(d, OWNER);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual({
      id: created.subscription.id,
      url: "https://hooks.example.com/ev",
      events: ["tip", "purchase"],
      createdAt: expect.any(String),
    });
    expect(listed[0]).not.toHaveProperty("secret");

    const del = await deleteSubscription(d, OWNER, created.subscription.id);
    expect(del).toEqual({ ok: true });
    expect(await listSubscriptions(d, OWNER)).toHaveLength(0);
  });

  it("rejects bad input", async () => {
    const d = deps();
    expect((await createSubscription(d, OWNER, "http://x.example/y", ["tip"])).ok).toBe(false);
    expect((await createSubscription(d, OWNER, "https://x.example/y", [])).ok).toBe(false);
    expect((await createSubscription(d, OWNER, "https://x.example/y", ["nope"])).ok).toBe(false);
  });

  it("caps subscriptions per owner", async () => {
    const d = deps();
    for (let i = 0; i < 10; i++) {
      const r = await createSubscription(d, OWNER, `https://x${i}.example.com/`, ["tip"]);
      expect(r.ok).toBe(true);
    }
    const over = await createSubscription(d, OWNER, "https://x10.example.com/", ["tip"]);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.status).toBe(409);
  });

  it("delete is owner-scoped (no oracle)", async () => {
    const d = deps();
    const created = await createSubscription(d, OWNER, "https://hooks.example.com/ev", ["tip"]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const other = await deleteSubscription(d, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", created.subscription.id);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.status).toBe(404);
    expect(await deleteSubscription(d, OWNER, "not-a-uuid")).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });
});

/* ---------------- dispatch ---------------- */

describe("dispatchToSubscription", () => {
  const OWNER = TO;
  const event = {
    event: "tip" as const,
    txId: "0xhash1",
    from: FROM,
    to: TO,
    amountTinybar: "500000000",
    timestamp: "1790000000.000000001",
  };

  async function fixture(d: WebhookDeps) {
    const created = await createSubscription(d, OWNER, "https://hooks.example.com/ev", ["tip"]);
    if (!created.ok) throw new Error("fixture failed");
    const raw = await d.store.get(`webhook:sub:${created.subscription.id}`);
    return JSON.parse(raw!) as WebhookSubscription;
  }

  it("delivers once, then dedupes", async () => {
    const d = deps();
    const sub = await fixture(d);
    const posts: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        posts.push({ url, init });
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
      }),
    );

    expect(await dispatchToSubscription(d, sub, event)).toBe("delivered");
    expect(await dispatchToSubscription(d, sub, event)).toBe("skippedDedupe");
    expect(posts).toHaveLength(1);

    const sent = posts[0];
    const headers = sent.init.headers as Record<string, string>;
    expect(headers["x-vs-signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["x-vs-delivery"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(verifyDeliverySignature(sub.secret, sent.init.body as string, headers["x-vs-signature"])).toBe(true);
    expect(JSON.parse(sent.init.body as string)).toMatchObject({ event: "tip", to: TO });
  });

  it("refuses to dispatch when DNS resolves to a private address", async () => {
    const d = deps({ resolveHost: async () => ["127.0.0.1"] });
    const sub = await fixture(d);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await dispatchToSubscription(d, sub, event)).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ---------------- poll ---------------- */

describe("pollAndDispatch", () => {
  const RECIPIENT = TO;

  async function subscribed(d: WebhookDeps, events: ("tip" | "purchase")[] = ["tip", "purchase"]) {
    const created = await createSubscription(d, RECIPIENT, "https://hooks.example.com/ev", events);
    if (!created.ok) throw new Error("fixture failed");
    const raw = await d.store.get(`webhook:sub:${created.subscription.id}`);
    return { id: created.subscription.id, secret: (JSON.parse(raw!) as WebhookSubscription).secret };
  }

  function mirrorFetch(logs: unknown[]) {
    const deliveries: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/results/logs")) {
          return { ok: true, json: async () => ({ logs }) };
        }
        if (u.includes("/api/v1/transactions?")) {
          // Echo the queried timestamp so distinct events get distinct tx ids.
          const ts = new URL(u).searchParams.get("timestamp") ?? "0.0";
          return { ok: true, json: async () => ({ transactions: [{ transaction_id: `0.0.99999@${ts}` }] }) };
        }
        deliveries.push({ url: u, init: init as RequestInit });
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
      }),
    );
    return deliveries;
  }

  it("seeds the cursor on first run and dispatches nothing", async () => {
    const d = deps();
    const r = await pollAndDispatch(d);
    expect(r.seeded).toBe(true);
    expect(r.events).toBe(0);
    const cursor = await d.store.get("webhook:cursor");
    expect(cursor).toMatch(/^\d+\.000000000$/);
  });

  it("dispatches new tip + purchase events to the recipient's subs and advances the cursor", async () => {
    const d = deps();
    const { secret } = await subscribed(d);
    await d.store.set("webhook:cursor", "1789999999.000000000", DURABLE_TTL);

    const deliveries = mirrorFetch([tipLog("1790000000.000000001"), saleLog("1790000000.000000002")]);
    const r = await pollAndDispatch(d);

    expect(r.events).toBe(2);
    expect(r.delivered).toBe(2);
    expect(deliveries).toHaveLength(2);
    const bodies = deliveries.map((x) => JSON.parse(x.init.body as string));
    expect(bodies.map((b) => b.event).sort()).toEqual(["purchase", "tip"]);
    // txId resolved via the mirror node, not the raw hash.
    expect(bodies[0].txId).toBe("0.0.99999@1790000000.000000001");
    const sig = (deliveries[0].init.headers as Record<string, string>)["x-vs-signature"];
    expect(verifyDeliverySignature(secret, deliveries[0].init.body as string, sig)).toBe(true);

    expect(await d.store.get("webhook:cursor")).toBe("1790000000.000000002");
  });

  it("only delivers subscribed event kinds", async () => {
    const d = deps();
    await subscribed(d, ["purchase"]);
    await d.store.set("webhook:cursor", "1789999999.000000000", DURABLE_TTL);
    const deliveries = mirrorFetch([tipLog("1790000000.000000001")]);
    const r = await pollAndDispatch(d);
    expect(r.events).toBe(1);
    expect(r.delivered).toBe(0);
    expect(deliveries).toHaveLength(0);
  });

  it("throws on mirror-node failure so the cursor does not advance", async () => {
    const d = deps();
    await d.store.set("webhook:cursor", "1789999999.000000000", DURABLE_TTL);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(pollAndDispatch(d)).rejects.toThrow(/mirror node 500/);
    expect(await d.store.get("webhook:cursor")).toBe("1789999999.000000000");
  });
});
