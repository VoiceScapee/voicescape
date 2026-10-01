/**
 * Tests for lib/server/notify.ts — human return-loop notifications.
 *
 * - Mention extraction, snippets, address forms.
 * - PurchaseCompleted log decoding.
 * - Inbox write/read (cap, dedupe, address forms) and follow-event log.
 * - runSocialSweep with mocked HCS/registry/KV/fetch: reply, mention,
 *   wall-post, follow, and sale detection; idempotency; watermark advance;
 *   push delivery + dead-subscription pruning; sendPush=false backfill mode.
 * - clampSinceMs bounds.
 *
 * No network, no real web-push, no mirror node.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createMemoryKvStore } from "./store";
import type { HcsPort } from "./townhall/hcs";
import type { RegistryPort } from "./townhall/registry-check";
import type { StoredMessage, TownhallMessage } from "./townhall/types";
import {
  NOTIF_FOLLOW_EVENTS_IDX_KV_KEY,
  NOTIF_FOLLOW_EVENTS_KV_KEY,
  NOTIF_FORUM_SEQ_KV_KEY,
  NOTIF_INBOX_CAP,
  NOTIF_INBOX_PREFIX,
  PURCHASE_COMPLETED_TOPIC0,
  addressForms,
  appendInbox,
  clampSinceMs,
  decodePurchaseLog,
  extractMentions,
  fetchTipItems,
  readInbox,
  recordFollowEvent,
  runSocialSweep,
  shortWallet,
  snippet,
  type SocialNotif,
  type SocialSweepDeps,
} from "./notify";
import { addSubscription, listSubscriptions } from "./push";

process.env.TOWNHALL_TOPIC_FORUM = "0.0.9001";
process.env.TOWNHALL_TOPIC_CHAT = "0.0.9002";
process.env.TOWNHALL_TOPIC_MARKET = "0.0.9003";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";
const DAVE = "0xdddddddddddddddddddddddddddddddddddddddd";

function mockRegistry(owners: Record<string, string> = {}): RegistryPort {
  return {
    isRegistered: async (u: string) => u.toLowerCase() in owners,
    resolveOwner: async (u: string) => owners[u.toLowerCase()] ?? null,
    resolvePage: async (u: string) =>
      u.toLowerCase() in owners ? { owner: owners[u.toLowerCase()], ownerType: 0 as const } : null,
  };
}

function post(seq: number, author: string, body: string, extra: Record<string, unknown> = {}): StoredMessage {
  return {
    seq,
    topic: "0.0.9001",
    consensusTimestamp: "2026-10-01T12:00:00.000Z",
    contents: {
      v: 1,
      kind: "post",
      ts: "2026-10-01T12:00:00.000Z",
      author,
      board: "general",
      wall: null,
      body,
      replyTo: null,
      ...extra,
    } as TownhallMessage,
  };
}

function chat(seq: number, author: string, room: string, body: string): StoredMessage {
  return {
    seq,
    topic: "0.0.9002",
    consensusTimestamp: "2026-10-01T12:00:00.000Z",
    contents: {
      v: 1,
      kind: "chat",
      ts: "2026-10-01T12:00:00.000Z",
      author,
      room,
      body,
    } as TownhallMessage,
  };
}

function mockHcs(forum: StoredMessage[] = [], chatMsgs: StoredMessage[] = []): HcsPort {
  const query = (async (_topic: string, opts?: { afterSeq?: number; limit?: number }) => {
    const all = _topic === "0.0.9001" ? forum : chatMsgs;
    const after = opts?.afterSeq ?? 0;
    return all.filter((m) => m.seq > after).slice(0, opts?.limit ?? 100);
  }) as HcsPort["query"];
  return {
    verifyTx: async () => null,
    query,
    queryAll: async () => [],
  };
}

function purchaseLog(overrides: Record<string, unknown> = {}) {
  const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
  const amountHex = (250_000_000n).toString(16).padStart(64, "0"); // 2.5 HBAR
  const feeHex = (5_000_000n).toString(16).padStart(64, "0");
  const ref = Buffer.from("listing-abc123", "utf8").toString("hex");
  const refLen = ref.length / 2;
  const data =
    "0x" +
    (96).toString(16).padStart(64, "0") +
    amountHex +
    feeHex +
    refLen.toString(16).padStart(64, "0") +
    ref.padEnd(Math.ceil(ref.length / 64) * 64, "0");
  return {
    transaction_hash: "0xdeedbeef",
    timestamp: "1789000000.123456789",
    topics: [PURCHASE_COMPLETED_TOPIC0, pad(BOB), pad(ALICE)],
    data,
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

function sweepDeps(
  kv: ReturnType<typeof createMemoryKvStore>,
  overrides: Partial<SocialSweepDeps> = {},
): SocialSweepDeps {
  return {
    kv,
    hcs: mockHcs(),
    registry: mockRegistry({ alice: ALICE, bob: BOB, carol: CAROL, dave: DAVE }),
    fetchImpl: mockFetch([]),
    sender: vi.fn(async () => {}),
    sendPush: false,
    siteUrl: "https://example.com",
    ...overrides,
  };
}

describe("extractMentions", () => {
  it("finds mentions, lowercases, dedupes", () => {
    expect(extractMentions("hey @Alice and @alice, meet @bob_99")).toEqual(["alice", "bob_99"]);
  });
  it("returns [] for non-strings and plain text", () => {
    expect(extractMentions("no mentions here")).toEqual([]);
    expect(extractMentions(undefined as unknown as string)).toEqual([]);
  });
  it("requires a word boundary before @", () => {
    expect(extractMentions("mail me at foo@bar.com")).toEqual([]);
  });
  it("matches after quotes and parens", () => {
    expect(extractMentions('said "@dave" (and @carol)')).toEqual(["dave", "carol"]);
  });
});

describe("snippet / shortWallet / addressForms", () => {
  it("collapses whitespace and truncates", () => {
    expect(snippet("a\n\nb   c", 4)).toBe("a b…");
    expect(snippet("hello")).toBe("hello");
  });
  it("shortens long wallets, passes short ones through", () => {
    expect(shortWallet(ALICE)).toBe("0xaaaa…aaaa");
    expect(shortWallet("0.0.123")).toBe("0.0.123");
  });
  it("maps 0.0.x to long-zero 0x and back", () => {
    const forms = addressForms("0.0.10424063");
    expect(forms).toContain("0.0.10424063");
    expect(forms).toContain("0x00000000000000000000000000000000009f0eff");
    expect(addressForms("0X00000000000000000000000000000000009F0EFF")).toContain("0.0.10424063");
  });
});

describe("decodePurchaseLog", () => {
  it("decodes buyer, seller, amount, listingRef", () => {
    const p = decodePurchaseLog(purchaseLog());
    expect(p).not.toBeNull();
    expect(p!.buyer).toBe(BOB);
    expect(p!.seller).toBe(ALICE);
    expect(p!.amountHbar).toBe("2.5000");
    expect(p!.listingRef).toBe("listing-abc123");
    expect(p!.timestampSec).toBeCloseTo(1789000000.123, 3);
  });
  it("returns null for the wrong topic", () => {
    expect(decodePurchaseLog(purchaseLog({ topics: ["0xdead"] }))).toBeNull();
  });
  it("returns null for malformed logs", () => {
    expect(decodePurchaseLog({})).toBeNull();
    expect(decodePurchaseLog(purchaseLog({ data: "0x1234" }))).toBeNull();
  });
});

describe("inbox", () => {
  it("writes under every address form and reads newest-first", async () => {
    const kv = createMemoryKvStore();
    const n1: SocialNotif = { id: "a", type: "reply", tsMs: 100, actor: "@x", title: "t", body: "b", url: "/" };
    const n2: SocialNotif = { id: "b", type: "mention", tsMs: 200, actor: "@y", title: "t", body: "b", url: "/" };
    await appendInbox(kv, ALICE, n1);
    await appendInbox(kv, ALICE, n2);
    // Read via the 0.0.x alias form.
    const aliceHedera = "0.0." + BigInt(ALICE).toString(10);
    const items = await readInbox(kv, aliceHedera);
    expect(items.map((i) => i.id)).toEqual(["b", "a"]);
  });
  it("dedupes by id and caps at NOTIF_INBOX_CAP", async () => {
    const kv = createMemoryKvStore();
    for (let i = 0; i < NOTIF_INBOX_CAP + 10; i++) {
      await appendInbox(kv, ALICE, {
        id: `n${i}`, type: "follow", tsMs: i, actor: "s", title: "t", body: "b", url: "/",
      });
    }
    const items = await readInbox(kv, ALICE);
    expect(items).toHaveLength(NOTIF_INBOX_CAP);
    expect(items[0].id).toBe(`n${NOTIF_INBOX_CAP + 9}`);
    // Re-append an existing id moves it to front without growing.
    await appendInbox(kv, ALICE, {
      id: "n0", type: "follow", tsMs: 9999, actor: "s", title: "t", body: "b", url: "/",
    });
    const items2 = await readInbox(kv, ALICE);
    expect(items2).toHaveLength(NOTIF_INBOX_CAP);
    expect(items2[0].id).toBe("n0");
  });
});

describe("recordFollowEvent", () => {
  it("appends and dedupes repeat follows", async () => {
    const kv = createMemoryKvStore();
    await recordFollowEvent(kv, BOB, "alice");
    await recordFollowEvent(kv, BOB, "alice");
    const raw = await kv.get(NOTIF_FOLLOW_EVENTS_KV_KEY);
    expect(JSON.parse(raw!).length).toBe(1);
  });
  it("never throws", async () => {
    const kv = createMemoryKvStore();
    await expect(recordFollowEvent(kv, "", "")).resolves.toBeUndefined();
  });
});

describe("runSocialSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects a forum reply and notifies the parent author", async () => {
    const kv = createMemoryKvStore();
    const hcs = mockHcs([post(10, "alice", "hello world"), post(11, "bob", "nice post!", { replyTo: 10 })]);
    const res = await runSocialSweep(sweepDeps(kv, { hcs }));
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect(res.body.events).toBe(1);
    const inbox = await readInbox(kv, ALICE);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe("reply");
    expect(inbox[0].actor).toBe("@bob");
    expect(inbox[0].id).toBe("reply:forum:11");
    // Watermark advanced past both posts.
    expect(await kv.get(NOTIF_FORUM_SEQ_KV_KEY)).toBe("11");
  });

  it("skips self-replies and unresolvable parents", async () => {
    const kv = createMemoryKvStore();
    const hcs = mockHcs([
      post(10, "alice", "hello"),
      post(11, "alice", "replying to myself", { replyTo: 10 }),
      post(12, "bob", "reply to ghost", { replyTo: 999 }),
    ]);
    const res = await runSocialSweep(sweepDeps(kv, { hcs }));
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect(res.body.events).toBe(0);
    expect(await readInbox(kv, ALICE)).toHaveLength(0);
  });

  it("detects @mentions in forum posts and chat, skips self-mentions", async () => {
    const kv = createMemoryKvStore();
    const hcs = mockHcs(
      [post(10, "alice", "shoutout to @carol and @alice (me)")],
      [chat(20, "dave", "lobby", "hey @carol check this out")],
    );
    const res = await runSocialSweep(sweepDeps(kv, { hcs }));
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const carolInbox = await readInbox(kv, CAROL);
    expect(carolInbox).toHaveLength(2);
    expect(carolInbox.map((i) => i.type).sort()).toEqual(["mention", "mention"]);
    expect(carolInbox.find((i) => i.id.startsWith("mention:chat"))!.url).toBe("/chat/lobby");
    // @alice self-mention skipped — alice's only item would be none here.
    expect(await readInbox(kv, ALICE)).toHaveLength(0);
  });

  it("notifies the wall owner of a top-level wall post", async () => {
    const kv = createMemoryKvStore();
    const hcs = mockHcs([post(10, "bob", "love your page!", { wall: "alice" })]);
    const res = await runSocialSweep(sweepDeps(kv, { hcs }));
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const inbox = await readInbox(kv, ALICE);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].title).toBe("New post on your wall");
    expect(inbox[0].url).toBe("/alice");
  });

  it("drains follow events and advances the index", async () => {
    const kv = createMemoryKvStore();
    await recordFollowEvent(kv, BOB, "alice");
    const res = await runSocialSweep(sweepDeps(kv, {}));
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const inbox = await readInbox(kv, ALICE);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe("follow");
    expect(await kv.get(NOTIF_FOLLOW_EVENTS_IDX_KV_KEY)).toBe("1");
    // Second run: nothing new.
    const res2 = await runSocialSweep(sweepDeps(kv, {}));
    expect(res2.status).toBe(200);
    if (res2.status !== 200) return;
    expect(res2.body.events).toBe(0);
  });

  it("detects marketplace sales from PurchaseCompleted logs", async () => {
    const kv = createMemoryKvStore();
    const deps = sweepDeps(kv, { fetchImpl: mockFetch([purchaseLog()]) });
    const res = await runSocialSweep(deps);
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect(res.body.events).toBe(1);
    const inbox = await readInbox(kv, ALICE);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe("sale");
    expect(inbox[0].body).toContain("2.5000 HBAR");
    expect(inbox[0].url).toBe("/marketplace/listing-abc123");
  });

  it("sends push in push mode and prunes dead subscriptions", async () => {
    const kv = createMemoryKvStore();
    const sender = vi.fn(async () => {});
    const deadSender = vi.fn(async () => {
      const err = new Error("gone") as Error & { statusCode: number };
      err.statusCode = 410;
      throw err;
    });
    const sub = { endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" }, lang: "en" };
    await addSubscription(kv, ALICE, sub);
    await addSubscription(kv, BOB, { ...sub, endpoint: "https://push.example/2" });

    // Sale to alice: push delivered.
    const deps = sweepDeps(kv, {
      fetchImpl: mockFetch([purchaseLog()]),
      sender,
      sendPush: true,
    });
    const res = await runSocialSweep(deps);
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect(sender).toHaveBeenCalledTimes(1);
    expect(res.body.sent).toBe(1);
    const payload = (sender.mock.calls[0] as unknown[])[1] as { title: string; url: string };
    expect(payload.title).toBe("Your item sold");
    expect(payload.url).toBe("https://example.com/marketplace/listing-abc123");

    // Dead subscription for bob pruned on 410.
    const deps2 = sweepDeps(kv, {
      hcs: mockHcs([post(10, "alice", "hi @bob")]),
      sender: deadSender,
      sendPush: true,
    });
    const res2 = await runSocialSweep(deps2);
    expect(res2.status).toBe(200);
    if (res2.status !== 200) return;
    expect(res2.body.pruned).toBe(1);
    expect(await listSubscriptions(kv, BOB)).toHaveLength(0);
  });

  it("writes inbox but sends no push in backfill mode", async () => {
    const kv = createMemoryKvStore();
    const sender = vi.fn(async () => {});
    await addSubscription(kv, ALICE, {
      endpoint: "https://push.example/1",
      keys: { p256dh: "p", auth: "a" },
      lang: "en",
    });
    const res = await runSocialSweep(
      sweepDeps(kv, { fetchImpl: mockFetch([purchaseLog()]), sender, sendPush: false }),
    );
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect(res.body.events).toBe(1);
    expect(sender).not.toHaveBeenCalled();
    expect(await readInbox(kv, ALICE)).toHaveLength(1);
  });

  it("is idempotent across runs", async () => {
    const kv = createMemoryKvStore();
    const hcs = mockHcs([post(10, "alice", "hello"), post(11, "bob", "hi!", { replyTo: 10 })]);
    const deps = () => sweepDeps(kv, { hcs, fetchImpl: mockFetch([purchaseLog()]) });
    const r1 = await runSocialSweep(deps());
    const r2 = await runSocialSweep(deps());
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    if (r1.status !== 200 || r2.status !== 200) return;
    expect(r1.body.events).toBe(2);
    expect(r2.body.events).toBe(0);
  });

  it("skips gracefully when topics are unconfigured", async () => {
    const kv = createMemoryKvStore();
    delete process.env.TOWNHALL_TOPIC_FORUM;
    delete process.env.TOWNHALL_TOPIC_CHAT;
    try {
      const res = await runSocialSweep(sweepDeps(kv, {}));
      expect(res.status).toBe(200);
    } finally {
      process.env.TOWNHALL_TOPIC_FORUM = "0.0.9001";
      process.env.TOWNHALL_TOPIC_CHAT = "0.0.9002";
    }
  });
});

describe("clampSinceMs", () => {
  it("defaults to 24h ago and clamps the window", () => {
    const now = Date.now();
    const d = clampSinceMs(undefined);
    expect(now - d).toBeGreaterThan(23 * 3600 * 1000);
    expect(now - d).toBeLessThan(25 * 3600 * 1000);
    expect(clampSinceMs(now + 99999)).toBeLessThan(now);
    expect(clampSinceMs(1)).toBe(now - 30 * 24 * 3600 * 1000);
    expect(clampSinceMs(now - 3600 * 1000)).toBe(now - 3600 * 1000);
  });
});

describe("fetchTipItems", () => {
  it("maps TipSent logs to digest items filtered by since", async () => {
    const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
    const amountHex = (150_000_000n).toString(16).padStart(64, "0");
    const feeHex = (3_000_000n).toString(16).padStart(64, "0");
    const logs = [
      {
        transaction_hash: "0xtip1",
        timestamp: "1789000100.000000000",
        topics: [
          "0xddb557901a5c7e767f2276c1190ca61ae148d62a74cfa61e4f7fa5319eaa431e",
          "0x" + "11".repeat(32),
          pad(BOB),
          pad(ALICE),
        ],
        data: "0x" + amountHex + feeHex,
      },
    ];
    const realFetch = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = mockFetch(logs);
    try {
      const items = await fetchTipItems(ALICE, 1789000000 * 1000);
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("tip");
      expect(items[0].body).toBe("You received 1.5000 HBAR");
      // Filtered out when since is newer.
      expect(await fetchTipItems(ALICE, 1789000200 * 1000)).toHaveLength(0);
    } finally {
      (globalThis as { fetch?: unknown }).fetch = realFetch;
    }
  });
});
