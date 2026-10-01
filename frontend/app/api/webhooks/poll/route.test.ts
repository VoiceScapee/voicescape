/**
 * GET /api/webhooks/poll route tests: CRON_SECRET guard, dispatch flow,
 * mirror-node failure mapping.
 *
 * The dispatcher itself is real; DNS is stubbed via an injected
 * defaultWebhookDeps; fetch is stubbed per-test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { getKvStore } from "@/lib/server/store";

vi.mock("@/lib/server/rate-limit", () => ({
  ipGate: async () => null,
}));

vi.mock("@/lib/server/webhooks", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/server/webhooks")>();
  const { getKvStore } = await import("@/lib/server/store");
  return {
    ...mod,
    defaultWebhookDeps: () => ({
      store: getKvStore(),
      verifySession: async () => ({ ok: false, error: "unused" }),
      resolvePageOwner: async () => null,
      mirrorBase: () => "https://mirror.test",
      tipsContract: () => "0.0.99999",
      resolveHost: async () => ["93.184.216.34"],
      nowMs: () => 1_700_000_000_000,
    }),
  };
});

import { GET } from "./route";

const CRON = "test-cron-secret";
const TIPS = new ethers.Interface([
  "event TipSent(string indexed username, address indexed from, address indexed toOwner, uint256 amount, uint256 fee)",
]);
const TO = "0x2222222222222222222222222222222222222222";
const FROM = "0x1111111111111111111111111111111111111111";
const DURABLE_TTL = 10 * 365 * 24 * 3600 * 1000;

function req(): NextRequest {
  return new NextRequest("http://localhost/api/webhooks/poll", {
    headers: { authorization: `Bearer ${CRON}` },
  });
}

function tipLog() {
  const { topics, data } = TIPS.encodeEventLog("TipSent", ["u", FROM, TO, 100_000_000n, 2_000_000n]);
  return { topics, data, timestamp: "1790000000.000000001", transaction_hash: "0xhash9" };
}

beforeEach(async () => {
  process.env.CRON_SECRET = CRON;
  await getKvStore().clearPrefix("webhook:");
  await getKvStore().clearPrefix("vs:iprl:");
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  vi.unstubAllGlobals();
});

describe("cron guard", () => {
  it("503 when CRON_SECRET is unset (fail closed)", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req());
    expect(res.status).toBe(503);
  });

  it("401 with a wrong bearer", async () => {
    const bad = new NextRequest("http://localhost/api/webhooks/poll", {
      headers: { authorization: "Bearer wrong" },
    });
    expect((await GET(bad)).status).toBe(401);
  });

  it("401 with no bearer", async () => {
    const bare = new NextRequest("http://localhost/api/webhooks/poll");
    expect((await GET(bare)).status).toBe(401);
  });
});

describe("dispatch flow", () => {
  async function seedSubscription() {
    // Insert directly: the subscription API needs a wallet session.
    const store = getKvStore();
    const sub = {
      id: "11111111-2222-4333-8444-555555555555",
      url: "https://hooks.example.com/ev",
      events: ["tip"],
      owner: TO,
      secret: "cd".repeat(32),
      createdAt: new Date(1_700_000_000_000).toISOString(),
    };
    await store.set(`webhook:sub:${sub.id}`, JSON.stringify(sub), DURABLE_TTL);
    await store.set(`webhook:subs:${TO}`, JSON.stringify([sub.id]), DURABLE_TTL);
    await store.set("webhook:cursor", "1789999999.000000000", DURABLE_TTL);
    return sub;
  }

  it("delivers a new tip to the subscribed wallet", async () => {
    const sub = await seedSubscription();
    const deliveries: { url: string; init: RequestInit }[] = [];
    let logsServed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/results/logs")) {
          const logs = logsServed ? [] : [tipLog()];
          logsServed = true;
          return { ok: true, json: async () => ({ logs }) };
        }
        if (u.includes("/api/v1/transactions?")) {
          return { ok: true, json: async () => ({ transactions: [{ transaction_id: "0.0.99999@1790000000.000000001" }] }) };
        }
        deliveries.push({ url: u, init: init as RequestInit });
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
      }),
    );

    const res = await GET(req());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, events: 1, delivered: 1 });

    expect(deliveries).toHaveLength(1);
    const headers = deliveries[0].init.headers as Record<string, string>;
    const { verifyDeliverySignature } = await import("@/lib/server/webhooks");
    expect(
      verifyDeliverySignature(sub.secret, deliveries[0].init.body as string, headers["x-vs-signature"]),
    ).toBe(true);
    expect(JSON.parse(deliveries[0].init.body as string)).toMatchObject({
      event: "tip",
      to: TO,
      txId: "0.0.99999@1790000000.000000001",
    });

    // Second tick: cursor advanced, nothing new.
    const res2 = await GET(req());
    expect((await res2.json()).delivered).toBe(0);
    expect(deliveries).toHaveLength(1);
  });

  it("502 when the mirror node is down (cursor unadvanced)", async () => {
    const store = getKvStore();
    await store.set("webhook:cursor", "1789999999.000000000", DURABLE_TTL);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await store.get("webhook:cursor")).toBe("1789999999.000000000");
  });
});
