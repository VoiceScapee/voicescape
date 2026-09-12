/**
 * Town Hall handler tests — every dependency mocked (in-memory HCS,
 * stubbed mirror node + registry). No network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  castRepVote,
  collectReferralCounts,
  createChatRoom,
  createEvent,
  createListing,
  createPost,
  createProposal,
  getBoards,
  getEvents,
  getListings,
  getPosts,
  getProfileLinks,
  getProposals,
  getReferralStats,
  getReputation,
  postChat,
  queryChatMessages,
  queryChatRooms,
  queryListingViews,
  queryPostViews,
  queryProposalEvents,
  queryReports,
  recordReferral,
  searchListings,
  setListingStatus,
  setProfileLinks,
  submitAppeal,
  submitModAction,
  submitReport,
  getModStatus,
  voteProposal,
  type TownhallDeps,
} from "./handlers";
import { MemoryHcsClient } from "./hcs";
import type { MirrorPort } from "./mirror";
import { clearConsumedDustFees } from "./mirror";
import type { RegistryPort } from "./registry-check";
import type { AuthPort } from "./auth";
import type { SalesPort } from "./sales";
import { globalQuotaStore } from "../quota";

process.env.TOWNHALL_TOPIC_FORUM = "0.0.7001";
process.env.TOWNHALL_TOPIC_CHAT = "0.0.7002";
process.env.TOWNHALL_TOPIC_VOTES = "0.0.7003";
process.env.TOWNHALL_TOPIC_GOV = "0.0.7004";
process.env.TOWNHALL_TOPIC_MARKET = "0.0.7005";
process.env.TOWNHALL_MODS = "brandon";
// Dust-fee economics floor: HCS_SUBMIT_FEE_TINYBARS × 2 must stay below the
// mock fee (1000 tinybars) used across these tests, or the economics guard
// would 503 every write. 100 × 2 = 200 < 1000.
process.env.HCS_SUBMIT_FEE_TINYBARS = "100";

beforeEach(async () => {
  await clearConsumedDustFees();
});

/** On-chain page owners in the test world. */
const OWNERS: Record<string, string> = {
  brandon: "0x000000000000000000000000000000000000b001",
  alice: "0x000000000000000000000000000000000000a11c",
  bob: "0x00000000000000000000000000000000000000b0",
  // carol's wallet doubles as the TOWNHALL_MOD_WALLETS fixture address
  // (0.0.424242) in the wallet-mod tests below.
  carol: "0x0000000000000000000000000000000000067932",
  // The platform owner's REAL ECDSA-derived EVM address for 0.0.10424063
  // (proven on-chain at user-10424063 registration). The dust-fee owner
  // bypass must match this form — NOT the long-zero form that
  // canonicalAddress("0.0.10424063") produces.
  owner: "0x30c63dc43608b6764a6b8b53960553aebf306817",
};

/**
 * Test session credential for a username. The stub auth port below maps the
 * signature back to the username's owner address — mirroring what the real
 * port does with cryptographic verification.
 */
function testCred(username: string): { message: string; signature: string } {
  return { message: `test-signin:${username}`, signature: `0xtest-${username}` };
}

function makeDeps(opts: { feeOk?: boolean; purchases?: [string, string][] } = {}): TownhallDeps {
  const mirror: MirrorPort = {
    verifyDustFee: async () =>
      opts.feeOk === false
        ? { ok: false, reason: "underpaid", receivedTinybars: 0 }
        : { ok: true, reason: "ok", receivedTinybars: 1000 },
    feeInfo: () => ({ dustFeeTinybars: 1000, treasury: "0.0.999" }),
    resolveAccountId: async (address: string) => {
      // Test mock: long-zero 0x...0eff -> 0.0.10424063, else pass through 0.0.x
      if (/^0x0*9f0eff$/i.test(address)) return "0.0.10424063";
      if (/^0\.0\.\d+$/.test(address)) return address;
      return null;
    },
  };
  const registry: RegistryPort = {
    isRegistered: async (u) => u.trim().toLowerCase() in OWNERS,
    resolveOwner: async (u) => OWNERS[u.trim().toLowerCase()] ?? null,
  };
  // Proof-of-payment: [buyerUsername, sellerUsername] pairs with a completed
  // on-chain purchase in the test world. Matched by canonical address, like
  // the real port does when it finds a PurchaseCompleted log.
  const completed = new Set(
    (opts.purchases ?? []).map(([b, s]) => `${OWNERS[b]}>${OWNERS[s]}`),
  );
  const sales: SalesPort = {
    hasCompletedPurchase: async (buyer, seller) =>
      completed.has(`${buyer.toLowerCase()}>${seller.toLowerCase()}`),
  };
  const auth: AuthPort = {
    verifySession: async (cred: unknown) => {
      const sig = (cred as { signature?: unknown } | null)?.signature;
      const m = typeof sig === "string" ? /^0xtest-([a-z]+)$/.exec(sig) : null;
      const user = m?.[1];
      const address = user ? OWNERS[user] : undefined;
      if (!address) return { ok: false, error: "missing session: sign in with your wallet" };
      return {
        ok: true,
        session: {
          address,
          chainId: 296,
          nonce: `test-${user}`,
          expiresAtMs: Date.now() + 3600_000,
        },
      };
    },
  };
  return { hcs: new MemoryHcsClient(), mirror, registry, auth, sales };
}

let feeCounter = 0;
/** Fresh fee tx id per call: the consumed-tx registry rejects replays, so
 *  tests must not share one tx id across successful writes. */
function fee() {
  feeCounter += 1;
  return { dustFeeTxId: `0.0.123@1694000000.${String(feeCounter).padStart(9, "0")}` };
}

describe("getBoards", () => {
  it("returns the four seed boards", () => {
    const { status, json } = getBoards();
    expect(status).toBe(200);
    const ids = (json as { boards: { id: string }[] }).boards.map((b) => b.id);
    expect(ids).toEqual(["general", "announcements", "ideas", "help"]);
  });
});

describe("dust-fee enforcement (402)", () => {
  it("createPost returns 402 without a fee", async () => {
    const r = await createPost(makeDeps(), { author: "alice", auth: testCred("alice"), body: "hello" });
    expect(r.status).toBe(402);
    const j = r.json as Record<string, unknown>;
    expect(j.dustFeeTinybars).toBe(1000);
    expect(j.treasury).toBe("0.0.999");
  });

  it("createProposal returns 402 without a fee", async () => {
    const r = await createProposal(makeDeps(), {
      author: "alice",
      auth: testCred("alice"),
      title: "T",
      body: "B",
      closesAt: "2026-12-01T00:00:00Z",
    });
    expect(r.status).toBe(402);
  });

  it("postChat returns 402 without a fee", async () => {
    const r = await postChat(makeDeps(), "lobby", { author: "alice", auth: testCred("alice"), body: "hi" });
    expect(r.status).toBe(402);
  });

  it("createListing returns 402 without a fee", async () => {
    const r = await createListing(makeDeps(), {
      seller: "0x000000000000000000000000000000000000a11c",
      sellerUsername: "alice",
      auth: testCred("alice"),
      title: "T",
      description: "D",
      priceUsdCents: 100,
      goodsType: "digital",
    });
    expect(r.status).toBe(402);
  });

  it("rejects an invalid/underpaid fee with 402", async () => {
    const r = await createPost(makeDeps({ feeOk: false }), {
      author: "alice",
      auth: testCred("alice"),
      body: "hello",
      ...fee(),
    });
    expect(r.status).toBe(402);
    expect((r.json as { error: string }).error).toMatch(/invalid/);
  });

  it("two concurrent writes with the same fee tx id: exactly one succeeds", async () => {
    // Regression: the fee tx id must be RESERVED synchronously before the
    // awaited mirror-node verification, so a second concurrent request
    // presenting the same tx id is rejected instead of double-spending it.
    const deps = makeDeps();
    let releaseVerify!: () => void;
    let verifyCalls = 0;
    (deps.mirror as MirrorPort).verifyDustFee = async () => {
      verifyCalls += 1;
      await new Promise<void>((res) => {
        releaseVerify = res;
      });
      return { ok: true, reason: "ok", receivedTinybars: 1000 };
    };
    const txId = "0.0.123@1694000000.000000999";
    const p1 = createPost(deps, { author: "alice", auth: testCred("alice"), body: "one", dustFeeTxId: txId });
    const p2 = createPost(deps, { author: "alice", auth: testCred("alice"), body: "two", dustFeeTxId: txId });
    // Wait until the winner's verification is in flight, then give the loser
    // a chance to reach the reservation.
    for (let i = 0; i < 200 && verifyCalls === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(verifyCalls).toBe(1); // the loser was rejected before verifying
    await new Promise((r) => setTimeout(r, 25));
    releaseVerify();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1.status, r2.status].sort()).toEqual([201, 402]);
    expect(verifyCalls).toBe(1);
  });

  it("the treasury owner posts free (no dust fee, no self-transfer)", async () => {
    // Regression: the owner's ECDSA-derived EVM address must match the
    // bypass — canonicalAddress("0.0.10424063") yields the long-zero form,
    // which never equals the wallet's real address, and the bypass silently
    // failed (owner got 402, then ACCOUNT_REPEATED_IN_ACCOUNT_AMOUNTS).
    const r = await createPost(makeDeps(), {
      author: "owner",
      auth: testCred("owner"),
      body: "owner post, no fee",
    });
    expect(r.status).toBe(201);
  });

  it("a failed fee verification releases the tx id for retry", async () => {
    const deps = makeDeps({ feeOk: false });
    const txId = "0.0.123@1694000000.000000998";
    const body = { author: "alice", auth: testCred("alice"), body: "x", dustFeeTxId: txId };
    expect((await createPost(deps, body)).status).toBe(402);
    // Same tx id after the fee problem is fixed: must not read "already used".
    (deps.mirror as MirrorPort).verifyDustFee = async () => ({
      ok: true,
      reason: "ok",
      receivedTinybars: 1000,
    });
    expect((await createPost(deps, body)).status).toBe(201);
  });
});

describe("createPost / getPosts", () => {
  let deps: TownhallDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("creates a post and returns its seq", async () => {
    const r = await createPost(deps, { author: "alice", auth: testCred("alice"), body: "hello world", ...fee() });
    expect(r.status).toBe(201);
    expect((r.json as { seq: number }).seq).toBe(1);
  });

  it("rejects unregistered authors with 403", async () => {
    const r = await createPost(deps, { author: "mallory", auth: testCred("alice"), body: "hi", ...fee() });
    expect(r.status).toBe(403);
  });

  it("rejects non-mods posting to announcements", async () => {
    const r = await createPost(deps, { author: "alice", auth: testCred("alice"), board: "announcements", body: "hi", ...fee() });
    expect(r.status).toBe(403);
  });

  it("lets mods post to announcements", async () => {
    const r = await createPost(deps, { author: "brandon", auth: testCred("brandon"), board: "announcements", body: "hi", ...fee() });
    expect(r.status).toBe(201);
  });

  it("rejects unknown boards", async () => {
    const r = await createPost(deps, { author: "alice", auth: testCred("alice"), board: "nope", body: "hi", ...fee() });
    expect(r.status).toBe(400);
  });

  it("rejects wall posts for unregistered wall owners", async () => {
    const r = await createPost(deps, { author: "alice", auth: testCred("alice"), wall: "mallory", body: "hi", ...fee() });
    expect(r.status).toBe(400);
  });

  it("orders posts newest-first and paginates with before", async () => {
    for (const b of ["one", "two", "three"]) {
      await createPost(deps, { author: "alice", auth: testCred("alice"), body: b, ...fee() });
    }
    const first = await getPosts(deps, { limit: "2" });
    const posts = (first.json as { posts: { seq: number; body: string }[] }).posts;
    expect(posts.map((p) => p.seq)).toEqual([3, 2]);
    expect(posts[0].body).toBe("three");
    const second = await getPosts(deps, { before: "2" });
    const older = (second.json as { posts: { seq: number }[] }).posts;
    expect(older.map((p) => p.seq)).toEqual([1]);
  });

  it("filters by board and wall", async () => {
    await createPost(deps, { author: "alice", auth: testCred("alice"), board: "ideas", body: "idea", ...fee() });
    await createPost(deps, { author: "alice", auth: testCred("alice"), wall: "bob", body: "wall post", ...fee() });
    await createPost(deps, { author: "bob", auth: testCred("bob"), body: "general", ...fee() });
    const byBoard = (await getPosts(deps, { board: "ideas" })).json as { posts: unknown[] };
    expect(byBoard.posts).toHaveLength(1);
    const byWall = (await getPosts(deps, { wall: "bob" })).json as { posts: unknown[] };
    expect(byWall.posts).toHaveLength(1);
  });

  it("supports replies via replyTo", async () => {
    await createPost(deps, { author: "alice", auth: testCred("alice"), body: "parent", ...fee() });
    const r = await createPost(deps, { author: "bob", auth: testCred("bob"), body: "child", replyTo: 1, ...fee() });
    expect(r.status).toBe(201);
    const posts = ((await getPosts(deps, {})).json as { posts: { replyTo: number | null }[] }).posts;
    expect(posts.find((p) => p.replyTo === 1)).toBeTruthy();
  });

  it("filters posts hidden by a mod-action", async () => {
    await createPost(deps, { author: "alice", auth: testCred("alice"), body: "spam", ...fee() });
    await createPost(deps, { author: "alice", auth: testCred("alice"), body: "fine", ...fee() });
    (deps.hcs as MemoryHcsClient).seed(process.env.TOWNHALL_TOPIC_FORUM!, {
      v: 1,
      kind: "mod-action",
      ts: "2026-09-10T00:00:00Z",
      author: "brandon",
      auth: testCred("brandon"),
      board: null,
      wall: null,
      targetSeq: 1,
      action: "hide",
    });
    const posts = ((await getPosts(deps, {})).json as { posts: { seq: number }[] }).posts;
    expect(posts.map((p) => p.seq)).toEqual([2]);
  });
});

describe("reputation", () => {
  let deps: TownhallDeps;
  beforeEach(() => {
    // alice and brandon each have a completed purchase from bob.
    deps = makeDeps({ purchases: [["alice", "bob"], ["brandon", "bob"]] });
  });

  it("rejects self-votes with 400", async () => {
    const r = await castRepVote(deps, { target: "alice", voter: "alice", auth: testCred("alice"), value: 1 });
    expect(r.status).toBe(400);
  });

  it("rejects unregistered voters with 403", async () => {
    const r = await castRepVote(deps, { target: "alice", voter: "mallory", auth: testCred("alice"), value: 1 });
    expect(r.status).toBe(403);
  });

  it("rejects invalid values with 400", async () => {
    const r = await castRepVote(deps, { target: "alice", voter: "bob", auth: testCred("bob"), value: 5 });
    expect(r.status).toBe(400);
  });

  it("rejects votes without a completed purchase (403 proof-of-payment)", async () => {
    // bob has no completed purchase from alice → cannot vote for alice.
    const r = await castRepVote(makeDeps(), { target: "alice", voter: "bob", auth: testCred("bob"), value: 1 });
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toMatch(/proof-of-payment/i);
  });

  it("rejects votes for unregistered targets (403)", async () => {
    const r = await castRepVote(deps, { target: "mallory", voter: "alice", auth: testCred("alice"), value: 1 });
    expect(r.status).toBe(403);
  });

  it("returns 503 when purchase history cannot be verified", async () => {
    const bad = makeDeps();
    bad.sales = { hasCompletedPurchase: async () => { throw new Error("mirror down"); } };
    const r = await castRepVote(bad, { target: "bob", voter: "alice", auth: testCred("alice"), value: 1 });
    expect(r.status).toBe(503);
  });

  it("tallies votes and reflects changes", async () => {
    await castRepVote(deps, { target: "bob", voter: "alice", auth: testCred("alice"), value: 1 });
    await castRepVote(deps, { target: "bob", voter: "brandon", auth: testCred("brandon"), value: -1 });
    let r = await getReputation(deps, "bob", "alice");
    expect(r.json).toMatchObject({ target: "bob", up: 1, down: 1, score: 0, myVote: 1 });
    // changeable: alice flips to -1
    await castRepVote(deps, { target: "bob", voter: "alice", auth: testCred("alice"), value: -1 });
    r = await getReputation(deps, "bob", "alice");
    expect(r.json).toMatchObject({ up: 0, down: 2, score: -2, myVote: -1 });
  });

  it("myVote is null when the viewer has not voted", async () => {
    await castRepVote(deps, { target: "bob", voter: "alice", auth: testCred("alice"), value: 1 });
    const r = await getReputation(deps, "bob", "carol");
    expect((r.json as { myVote: unknown }).myVote).toBe(null);
  });
});

describe("proposals", () => {
  let deps: TownhallDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("creates a proposal and returns an id", async () => {
    const r = await createProposal(deps, {
      author: "alice",
      auth: testCred("alice"),
      title: "Fund the fountain",
      body: "Build it.",
      closesAt: "2026-12-01T00:00:00Z",
      ...fee(),
    });
    expect(r.status).toBe(201);
    expect(typeof (r.json as { id: string }).id).toBe("string");
  });

  it("rejects a bad closesAt", async () => {
    const r = await createProposal(deps, {
      author: "alice",
      auth: testCred("alice"),
      title: "T",
      body: "B",
      closesAt: "not-a-date",
      ...fee(),
    });
    expect(r.status).toBe(400);
  });

  it("counts votes with latest-wins", async () => {
    const { id } = (await createProposal(deps, {
      author: "alice",
      auth: testCred("alice"),
      title: "P",
      body: "B",
      closesAt: "2026-12-01T00:00:00Z",
      ...fee(),
    })).json as { id: string };
    await voteProposal(deps, id, { voter: "bob", auth: testCred("bob"), choice: "yes" });
    await voteProposal(deps, id, { voter: "brandon", auth: testCred("brandon"), choice: "no" });
    await voteProposal(deps, id, { voter: "bob", auth: testCred("bob"), choice: "abstain" }); // change
    const r = await voteProposal(deps, id, { voter: "alice", auth: testCred("alice"), choice: "yes" });
    expect(r.json).toEqual({ yes: 1, no: 1, abstain: 1 });
    const list = (await getProposals(deps)).json as { proposals: { id: string; yes: number; no: number; abstain: number }[] };
    const p = list.proposals.find((x) => x.id === id)!;
    expect(p).toMatchObject({ yes: 1, no: 1, abstain: 1 });
  });

  it("rejects invalid choices", async () => {
    const r = await voteProposal(deps, "p1", { voter: "bob", auth: testCred("bob"), choice: "maybe" });
    expect(r.status).toBe(400);
  });
});

describe("chat", () => {
  it("posts a chat message and reads it back in order", async () => {
    const deps = makeDeps();
    const r1 = await postChat(deps, "lobby", { author: "alice", auth: testCred("alice"), body: "first", ...fee() });
    const r2 = await postChat(deps, "lobby", { author: "bob", auth: testCred("bob"), body: "second", ...fee() });
    await postChat(deps, "other", { author: "alice", auth: testCred("alice"), body: "elsewhere", ...fee() });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const events = await queryChatMessages(deps, "lobby");
    expect(events.map((e) => e.body)).toEqual(["first", "second"]);
    expect(events[0]).toMatchObject({ room: "lobby", author: "alice" });
    expect(events.map((e) => e.seq)).toEqual([1, 2]); // ordered by seq
    const after = await queryChatMessages(deps, "lobby", 1);
    expect(after.map((e) => e.seq)).toEqual([2]);
  });
});

describe("chat rooms", () => {
  it("creates a room and lists it after the lobby", async () => {
    const deps = makeDeps();
    const r = await createChatRoom(deps, {
      author: "alice",
      auth: testCred("alice"),
      id: "agent-coffee",
      title: "Agent Coffee Chat",
      description: "Agents and humans talk shop.",
      ...fee(),
    });
    expect(r.status).toBe(201);
    expect((r.json as { roomId: string }).roomId).toBe("agent-coffee");

    const q = await queryChatRooms(deps);
    expect(q.status).toBe(200);
    const rooms = (q.json as { rooms: { id: string; creator: string }[] }).rooms;
    expect(rooms[0].id).toBe("lobby");
    const created = rooms.find((x) => x.id === "agent-coffee");
    expect(created).toMatchObject({ title: "Agent Coffee Chat", creator: "alice" });
  });

  it("queryChatRooms always includes the lobby, even with no rooms", async () => {
    const q = await queryChatRooms(makeDeps());
    expect(q.status).toBe(200);
    const rooms = (q.json as { rooms: { id: string }[] }).rooms;
    expect(rooms.length).toBe(1);
    expect(rooms[0].id).toBe("lobby");
  });

  it("rejects invalid ids", async () => {
    const deps = makeDeps();
    const base = { author: "alice", auth: testCred("alice"), title: "Valid Title", ...fee() };
    for (const id of ["ab", "UPPER", "has space", "a".repeat(33), "lobby", "semi;colon"]) {
      const r = await createChatRoom(deps, { ...base, id, ...fee() });
      expect(r.status).toBe(400);
    }
  });

  it("rejects bad titles and long descriptions", async () => {
    const deps = makeDeps();
    const base = { author: "alice", auth: testCred("alice"), id: "ok-room", ...fee() };
    const short = await createChatRoom(deps, { ...base, title: "AB", ...fee() });
    expect(short.status).toBe(400);
    const longDesc = await createChatRoom(deps, { ...base, title: "Valid Title", description: "x".repeat(201), ...fee() });
    expect(longDesc.status).toBe(400);
    const missing = await createChatRoom(deps, { ...base, ...fee() });
    expect(missing.status).toBe(400);
  });

  it("returns 409 on duplicate room id", async () => {
    const deps = makeDeps();
    const body = { author: "alice", auth: testCred("alice"), id: "dupe-room", title: "Dupe Room" };
    const first = await createChatRoom(deps, { ...body, ...fee() });
    expect(first.status).toBe(201);
    const second = await createChatRoom(deps, { ...body, ...fee() });
    expect(second.status).toBe(409);
  });

  it("returns 402 without a dust fee", async () => {
    const r = await createChatRoom(makeDeps(), {
      author: "alice",
      auth: testCred("alice"),
      id: "no-fee-room",
      title: "No Fee Room",
    });
    expect(r.status).toBe(402);
    expect((r.json as Record<string, unknown>).dustFeeTinybars).toBe(1000);
  });

  it("rejects bad sessions and non-owners", async () => {
    const deps = makeDeps();
    const noSession = await createChatRoom(deps, {
      author: "alice",
      id: "r1",
      title: "Room One",
      ...fee(),
    });
    expect(noSession.status).toBe(401);
    const wrongWallet = await createChatRoom(deps, {
      author: "alice",
      auth: testCred("bob"),
      id: "r2",
      title: "Room Two",
      ...fee(),
    });
    expect(wrongWallet.status).toBe(403);
    const unregistered = await createChatRoom(deps, {
      author: "mallory",
      auth: testCred("alice"),
      id: "r3",
      title: "Room Three",
      ...fee(),
    });
    expect(unregistered.status).toBe(403);
  });

  it("room ids survive a chat message round-trip", async () => {
    const deps = makeDeps();
    await createChatRoom(deps, {
      author: "bob",
      auth: testCred("bob"),
      id: "dev-talk",
      title: "Dev Talk",
      ...fee(),
    });
    const m = await postChat(deps, "dev-talk", {
      author: "alice",
      auth: testCred("alice"),
      body: "hello in dev-talk",
      ...fee(),
    });
    expect(m.status).toBe(201);
    const events = await queryChatMessages(deps, "dev-talk");
    expect(events.map((e) => e.body)).toEqual(["hello in dev-talk"]);
  });
});

describe("events", () => {
  it("rejects non-mods with 403", async () => {
    const r = await createEvent(makeDeps(), {
      author: "alice",
      auth: testCred("alice"),
      title: "Party",
      description: "Fun",
      startsAt: "2026-12-01T18:00:00Z",
    });
    expect(r.status).toBe(403);
  });

  it("lets mods create events with room event-<id>", async () => {
    const deps = makeDeps();
    const r = await createEvent(deps, {
      author: "brandon",
      auth: testCred("brandon"),
      title: "Town Hall Live",
      description: "Q&A",
      startsAt: "2026-12-01T18:00:00Z",
    });
    expect(r.status).toBe(201);
    const { id } = r.json as { id: string };
    const list = (await getEvents(deps)).json as { events: { id: string; room: string }[] };
    expect(list.events).toHaveLength(1);
    expect(list.events[0].id).toBe(id);
    expect(list.events[0].room).toBe(`event-${id}`);
  });
});

describe("listings", () => {
  let deps: TownhallDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("creates a listing and returns an id", async () => {
    const r = await createListing(deps, {
      seller: "0x000000000000000000000000000000000000a11c",
      sellerUsername: "alice",
      auth: testCred("alice"),
      title: "Sticker pack",
      description: "Cool stickers",
      priceUsdCents: 500,
      goodsType: "physical",
      ...fee(),
    });
    expect(r.status).toBe(201);
  });

  it("rejects bad goodsType / price", async () => {
    const bad1 = await createListing(deps, {
      seller: "0x000000000000000000000000000000000000a11c",
      sellerUsername: "alice",
      auth: testCred("alice"),
      title: "T",
      description: "D",
      priceUsdCents: 100,
      goodsType: "service",
      ...fee(),
    });
    expect(bad1.status).toBe(400);
    const bad2 = await createListing(deps, {
      seller: "0x000000000000000000000000000000000000a11c",
      sellerUsername: "alice",
      auth: testCred("alice"),
      title: "T",
      description: "D",
      priceUsdCents: -5,
      goodsType: "digital",
      ...fee(),
    });
    expect(bad2.status).toBe(400);
  });

  it("seller-only status change; latest-wins on read", async () => {
    const { id } = (await createListing(deps, {
      seller: "0x000000000000000000000000000000000000a11c",
      sellerUsername: "alice",
      auth: testCred("alice"),
      title: "Sticker pack",
      description: "Cool stickers",
      priceUsdCents: 500,
      goodsType: "physical",
      ...fee(),
    })).json as { id: string };

    const other = await setListingStatus(deps, id, { sellerUsername: "bob", auth: testCred("bob"), status: "sold" });
    expect(other.status).toBe(403);
    const missing = await setListingStatus(deps, "nope", { sellerUsername: "alice", auth: testCred("alice"), status: "sold" });
    expect(missing.status).toBe(404);
    const badStatus = await setListingStatus(deps, id, { sellerUsername: "alice", auth: testCred("alice"), status: "shipped" });
    expect(badStatus.status).toBe(400);

    const r = await setListingStatus(deps, id, { sellerUsername: "alice", auth: testCred("alice"), status: "sold" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({});

    const list = (await getListings(deps)).json as { listings: { id: string; status: string }[] };
    expect(list.listings.find((l) => l.id === id)!.status).toBe("sold");
  });
});

describe("wallet-session auth", () => {
  it("rejects writes with no session credential (401)", async () => {
    const deps = makeDeps();
    expect((await createPost(deps, { author: "alice", body: "hi", ...fee() })).status).toBe(401);
    expect((await postChat(deps, "lobby", { author: "alice", body: "hi", ...fee() })).status).toBe(401);
    expect((await castRepVote(deps, { target: "bob", voter: "alice", value: 1 })).status).toBe(401);
    expect(
      (await createProposal(deps, { author: "alice", title: "T", body: "B", closesAt: "2026-12-01T00:00:00Z", ...fee() })).status,
    ).toBe(401);
    expect((await voteProposal(deps, "p1", { voter: "alice", choice: "yes" })).status).toBe(401);
    expect(
      (await createEvent(deps, { author: "brandon", title: "T", description: "D", startsAt: "2026-12-01T18:00:00Z" })).status,
    ).toBe(401);
    expect(
      (
        await createListing(deps, {
          seller: "0x000000000000000000000000000000000000a11c",
          sellerUsername: "alice",
          title: "T",
          description: "D",
          priceUsdCents: 100,
          goodsType: "digital",
          ...fee(),
        })
      ).status,
    ).toBe(401);
    expect((await setListingStatus(deps, "whatever", { sellerUsername: "alice", status: "sold" })).status).toBe(401);
  });

  it("rejects malformed credentials (401)", async () => {
    const deps = makeDeps();
    const r = await createPost(deps, { author: "alice", body: "hi", auth: { bogus: 1 }, ...fee() });
    expect(r.status).toBe(401);
    expect((r.json as { error: string }).error).toMatch(/sign in/i);
  });

  it("rejects a valid session claiming someone else's page (403)", async () => {
    const deps = makeDeps();
    // alice's wallet, bob's username
    const r = await createPost(deps, { author: "bob", auth: testCred("alice"), body: "hi", ...fee() });
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toMatch(/does not own/);
  });

  it("rejects votes and chats from a wallet that doesn't own the claimed page (403)", async () => {
    const deps = makeDeps();
    const v = await castRepVote(deps, { target: "bob", voter: "bob", auth: testCred("alice"), value: 1 });
    expect(v.status).toBe(403);
    const c = await postChat(deps, "lobby", { author: "bob", auth: testCred("alice"), body: "hi", ...fee() });
    expect(c.status).toBe(403);
  });

  it("setListingStatus still enforces seller-only with sessions", async () => {
    const deps = makeDeps();
    const { id } = (await createListing(deps, {
      seller: "0x000000000000000000000000000000000000a11c",
      sellerUsername: "alice",
      auth: testCred("alice"),
      title: "T",
      description: "D",
      priceUsdCents: 100,
      goodsType: "digital",
      ...fee(),
    })).json as { id: string };
    // bob has a valid session, but the listing is alice's
    const r = await setListingStatus(deps, id, { sellerUsername: "bob", auth: testCred("bob"), status: "sold" });
    expect(r.status).toBe(403);
    // alice's own session works
    const ok = await setListingStatus(deps, id, { sellerUsername: "alice", auth: testCred("alice"), status: "sold" });
    expect(ok.status).toBe(200);
  });

  it("createEvent: mods need a session too, and non-mods stay rejected", async () => {
    const deps = makeDeps();
    const noAuth = await createEvent(deps, {
      author: "brandon",
      title: "T",
      description: "D",
      startsAt: "2026-12-01T18:00:00Z",
    });
    expect(noAuth.status).toBe(401);
    const nonMod = await createEvent(deps, {
      author: "alice",
      auth: testCred("alice"),
      title: "T",
      description: "D",
      startsAt: "2026-12-01T18:00:00Z",
    });
    expect(nonMod.status).toBe(403);
  });
});

describe("listing payout address vs page identity", () => {
  const PAYOUT = "0x000000000000000000000000000000000000a11c";

  it("keeps the payout address and the sellerUsername in views", async () => {
    const deps = makeDeps();
    const { id } = (
      await createListing(deps, {
        seller: PAYOUT,
        sellerUsername: "alice",
        auth: testCred("alice"),
        title: "T",
        description: "D",
        priceUsdCents: 100,
        goodsType: "digital",
        ...fee(),
      })
    ).json as { id: string };
    const list = (await getListings(deps)).json as {
      listings: { id: string; seller: string; sellerUsername: string | null }[];
    };
    const l = list.listings.find((x) => x.id === id);
    expect(l?.seller).toBe(PAYOUT);
    expect(l?.sellerUsername).toBe("alice");
  });

  it("rejects a non-address payout seller (400)", async () => {
    const r = await createListing(makeDeps(), {
      seller: "not-an-address",
      sellerUsername: "alice",
      auth: testCred("alice"),
      title: "T",
      description: "D",
      priceUsdCents: 100,
      goodsType: "digital",
      ...fee(),
    });
    expect(r.status).toBe(400);
  });

  it("rejects a session that does not own the claimed sellerUsername (403)", async () => {
    const r = await createListing(makeDeps(), {
      seller: PAYOUT,
      sellerUsername: "bob",
      auth: testCred("alice"),
      title: "T",
      description: "D",
      priceUsdCents: 100,
      goodsType: "digital",
      ...fee(),
    });
    expect(r.status).toBe(403);
  });
});

describe("dust-fee replay protection", () => {
  it("rejects reuse of the same fee tx id on a second write", async () => {
    const deps = makeDeps();
    const txId = "0.0.123@1694000000.111111111";
    const body = (b: string) => ({
      author: "alice",
      auth: testCred("alice"),
      body: b,
      dustFeeTxId: txId,
    });
    const first = await createPost(deps, body("first"));
    expect(first.status).toBe(201);
    const second = await createPost(deps, body("second"));
    expect(second.status).toBe(402);
    expect((second.json as { error: string }).error).toMatch(/already used/);
  });

  it("rejects replay across different write kinds (post then chat)", async () => {
    const deps = makeDeps();
    const txId = "0.0.123@1694000000.222222222";
    const p = await createPost(deps, {
      author: "alice",
      auth: testCred("alice"),
      body: "hello",
      dustFeeTxId: txId,
    });
    expect(p.status).toBe(201);
    const c = await postChat(deps, "lobby", {
      author: "alice",
      auth: testCred("alice"),
      body: "hello again",
      dustFeeTxId: txId,
    });
    expect(c.status).toBe(402);
    expect((c.json as { error: string }).error).toMatch(/already used/);
  });

  it("does not consume the tx id when verification fails (retryable)", async () => {
    const deps = makeDeps({ feeOk: false });
    const txId = "0.0.123@1694000000.333333333";
    const body = () => ({
      author: "alice",
      auth: testCred("alice"),
      body: "hello",
      dustFeeTxId: txId,
    });
    const first = await createPost(deps, body());
    expect(first.status).toBe(402);
    expect((first.json as { error: string }).error).toMatch(/invalid/);
    // A failed verification must not burn the tx id: the next attempt
    // fails on verification again, not on "already used".
    const second = await createPost(deps, body());
    expect(second.status).toBe(402);
    expect((second.json as { error: string }).error).toMatch(/invalid/);
  });

  it("rejects concurrent reuse of the same fee tx id (no double-spend)", async () => {
    // Deferred verification: both requests sit inside the awaited verify
    // at the same time, forcing the check → await → mark interleaving
    // that used to let one payment fund two writes.
    let releaseVerify!: (r: { ok: boolean; reason: string; receivedTinybars: number }) => void;
    const verifyGate = new Promise<{ ok: boolean; reason: string; receivedTinybars: number }>(
      (res) => {
        releaseVerify = res;
      },
    );
    const base = makeDeps();
    const deps: TownhallDeps = {
      ...base,
      mirror: { ...base.mirror, verifyDustFee: () => verifyGate },
    };
    const txId = "0.0.123@1694000000.444444444";
    const body = (b: string) => ({
      author: "alice",
      auth: testCred("alice"),
      body: b,
      dustFeeTxId: txId,
    });
    const p1 = createPost(deps, body("first"));
    const p2 = createPost(deps, body("second"));
    // Let both requests reach the awaited verification before either resolves.
    await new Promise((r) => setTimeout(r, 20));
    releaseVerify({ ok: true, reason: "ok", receivedTinybars: 1000 });
    const [r1, r2] = await Promise.all([p1, p2]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 402]);
    const rejected = r1.status === 402 ? r1 : r2;
    expect((rejected.json as { error: string }).error).toMatch(/already used/);
  });

  it("normalizes the tx id: whitespace variants of one payment buy one write", async () => {
    const deps = makeDeps();
    const mkBody = (b: string, txId: string) => ({
      author: "alice",
      auth: testCred("alice"),
      body: b,
      dustFeeTxId: txId,
    });
    const first = await createPost(deps, mkBody("first", "0.0.123@1694000000.555555555 "));
    expect(first.status).toBe(201);
    const second = await createPost(deps, mkBody("second", "  0.0.123@1694000000.555555555"));
    expect(second.status).toBe(402);
    expect((second.json as { error: string }).error).toMatch(/already used/);
  });
});

describe("mod-actions", () => {
  async function postOnBoard(deps: TownhallDeps, author: string, body: string) {
    const r = await createPost(deps, {
      author,
      auth: testCred(author),
      board: "general",
      body,
      ...fee(),
    });
    expect(r.status).toBe(201);
    return (r.json as { seq: number }).seq;
  }

  it("rejects mod-actions without a session (401)", async () => {
    const r = await submitModAction(makeDeps(), {
      author: "brandon",
      targetKind: "post",
      targetSeq: 1,
    });
    expect(r.status).toBe(401);
  });

  it("rejects a non-moderator hiding a board post (403)", async () => {
    const deps = makeDeps();
    const seq = await postOnBoard(deps, "alice", "hello");
    const r = await submitModAction(deps, {
      author: "alice",
      auth: testCred("alice"),
      targetKind: "post",
      targetSeq: seq,
      board: "general",
    });
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toMatch(/not authorized/);
  });

  it("rejects hiding a nonexistent target (404)", async () => {
    const r = await submitModAction(makeDeps(), {
      author: "brandon",
      auth: testCred("brandon"),
      targetKind: "post",
      targetSeq: 424242,
      board: "general",
    });
    expect(r.status).toBe(404);
  });

  it("rejects a bad targetSeq (400)", async () => {
    const r = await submitModAction(makeDeps(), {
      author: "brandon",
      auth: testCred("brandon"),
      targetKind: "post",
      targetSeq: "one",
    });
    expect(r.status).toBe(400);
  });

  it("a global mod can hide a board post; it disappears from reads", async () => {
    const deps = makeDeps();
    const seq = await postOnBoard(deps, "alice", "spammy");
    const hide = await submitModAction(deps, {
      author: "brandon",
      auth: testCred("brandon"),
      targetKind: "post",
      targetSeq: seq,
      board: "general",
    });
    expect(hide.status).toBe(201);
    const posts = await getPosts(deps, { board: "general" });
    const seqs = ((posts.json as { posts: { seq: number }[] }).posts ?? []).map((p) => p.seq);
    expect(seqs).not.toContain(seq);
  });

  it("a wall owner can hide a post on their own wall", async () => {
    const deps = makeDeps();
    const r = await createPost(deps, {
      author: "bob",
      auth: testCred("bob"),
      wall: "alice",
      body: "rude comment",
      ...fee(),
    });
    expect(r.status).toBe(201);
    const seq = (r.json as { seq: number }).seq;
    const hide = await submitModAction(deps, {
      author: "alice",
      auth: testCred("alice"),
      targetKind: "post",
      targetSeq: seq,
      wall: "alice",
    });
    expect(hide.status).toBe(201);
    const wall = await getPosts(deps, { wall: "alice" });
    const seqs = ((wall.json as { posts: { seq: number }[] }).posts ?? []).map((p) => p.seq);
    expect(seqs).not.toContain(seq);
  });

  it("a wall owner cannot hide someone else's board post (403)", async () => {
    const deps = makeDeps();
    const seq = await postOnBoard(deps, "bob", "board post");
    const r = await submitModAction(deps, {
      author: "alice",
      auth: testCred("alice"),
      targetKind: "post",
      targetSeq: seq,
      board: "general",
    });
    expect(r.status).toBe(403);
  });

  it("a global mod can hide a chat message; it disappears from the room", async () => {
    const deps = makeDeps();
    const posted = await postChat(deps, "lobby", {
      author: "alice",
      auth: testCred("alice"),
      body: "bad message",
      ...fee(),
    });
    expect(posted.status).toBe(201);
    const seq = (posted.json as { seq: number }).seq;
    const hide = await submitModAction(deps, {
      author: "brandon",
      auth: testCred("brandon"),
      targetKind: "chat",
      targetSeq: seq,
      board: "lobby",
    });
    expect(hide.status).toBe(201);
    const events = await queryChatMessages(deps, "lobby", 0);
    expect(events.map((e) => e.seq)).not.toContain(seq);
  });

  it("a chat hide does not remove a forum post with the same seq", async () => {
    const deps = makeDeps();
    // Create a forum post and a chat message; both land at seq 1 in their
    // own topics (MemoryHcsClient sequences per topic).
    const postSeq = await postOnBoard(deps, "alice", "keep me");
    const chat = await postChat(deps, "lobby", {
      author: "alice",
      auth: testCred("alice"),
      body: "hide me",
      ...fee(),
    });
    expect(chat.status).toBe(201);
    const chatSeq = (chat.json as { seq: number }).seq;
    expect(chatSeq).toBe(postSeq); // same seq number, different topics
    const hide = await submitModAction(deps, {
      author: "brandon",
      auth: testCred("brandon"),
      targetKind: "chat",
      targetSeq: chatSeq,
      board: "lobby",
    });
    expect(hide.status).toBe(201);
    const posts = await getPosts(deps, { board: "general" });
    const seqs = ((posts.json as { posts: { seq: number }[] }).posts ?? []).map((p) => p.seq);
    expect(seqs).toContain(postSeq);
    const events = await queryChatMessages(deps, "lobby", 0);
    expect(events.map((e) => e.seq)).not.toContain(chatSeq);
  });

  it("an unauthorized mod-action never hides anything", async () => {
    const deps = makeDeps();
    const seq = await postOnBoard(deps, "alice", "still here");
    // Forge a mod-action directly into HCS from a non-mod (bypasses the
    // route, as an attacker with the operator key could).
    await deps.hcs.submit("0.0.7001", {
      v: 1,
      kind: "mod-action",
      ts: new Date().toISOString(),
      author: "mallory",
      targetKind: "post",
      board: "general",
      wall: null,
      targetSeq: seq,
      action: "hide",
    });
    const posts = await getPosts(deps, { board: "general" });
    const seqs = ((posts.json as { posts: { seq: number }[] }).posts ?? []).map((p) => p.seq);
    expect(seqs).toContain(seq);
  });
});

describe("wallet-based mods (TOWNHALL_MOD_WALLETS)", () => {
  const OLD_WALLETS = process.env.TOWNHALL_MOD_WALLETS;
  // 0.0.424242 canonicalizes to this address; it owns carol's page but is
  // NOT in TOWNHALL_MODS, so these tests exercise the wallet path only.
  const MOD_WALLET = "0x0000000000000000000000000000000000067932";
  afterEach(() => {
    if (OLD_WALLETS === undefined) delete process.env.TOWNHALL_MOD_WALLETS;
    else process.env.TOWNHALL_MOD_WALLETS = OLD_WALLETS;
  });

  const modWalletAuth: AuthPort = {
    verifySession: async () => ({
      ok: true,
      session: {
        address: MOD_WALLET,
        chainId: 296,
        nonce: "test-modwallet",
        expiresAtMs: Date.now() + 3600_000,
      },
    }),
  };
  /** Same deps (shared HCS/registry) but the session belongs to the mod wallet. */
  function asModWallet(deps: TownhallDeps): TownhallDeps {
    return { ...deps, auth: modWalletAuth };
  }
  const modCred = { message: "test-signin:modwallet", signature: "0xtest-modwallet" };

  async function postOnBoard(deps: TownhallDeps, author: string, body: string) {
    const r = await createPost(deps, {
      author,
      auth: testCred(author),
      board: "general",
      body,
      ...fee(),
    });
    expect(r.status).toBe(201);
    return (r.json as { seq: number }).seq;
  }

  it("a mod wallet can hide with no registered page, and the hide sticks", async () => {
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242";
    const deps = makeDeps();
    const seq = await postOnBoard(deps, "alice", "spammy");
    const r = await submitModAction(asModWallet(deps), {
      auth: modCred,
      targetKind: "post",
      targetSeq: seq,
      board: "general",
    });
    expect(r.status).toBe(201);
    // Authored under the wallet address (no page to author under).
    const stored = await deps.hcs.queryAll("0.0.7001");
    const action = stored.find((m) => m.contents.kind === "mod-action")?.contents as {
      author: string;
    };
    expect(action.author).toBe(MOD_WALLET);
    // Honored on reads.
    const posts = await getPosts(deps, { board: "general" });
    const seqs = ((posts.json as { posts: { seq: number }[] }).posts ?? []).map((p) => p.seq);
    expect(seqs).not.toContain(seq);
  });

  it("a mod wallet acting under its owned username records modWallet, hide sticks", async () => {
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242";
    const deps = makeDeps();
    const seq = await postOnBoard(deps, "alice", "spammy");
    const r = await submitModAction(asModWallet(deps), {
      author: "carol",
      auth: testCred("carol"),
      targetKind: "post",
      targetSeq: seq,
      board: "general",
    });
    expect(r.status).toBe(201);
    const stored = await deps.hcs.queryAll("0.0.7001");
    const action = stored.find((m) => m.contents.kind === "mod-action")?.contents as {
      author: string;
      modWallet: string | null;
    };
    expect(action.author).toBe("carol");
    expect(action.modWallet).toBe(MOD_WALLET);
    const posts = await getPosts(deps, { board: "general" });
    const seqs = ((posts.json as { posts: { seq: number }[] }).posts ?? []).map((p) => p.seq);
    expect(seqs).not.toContain(seq);
  });

  it("a mod wallet can post to a mod-only board with no registered page", async () => {
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242";
    const r = await createPost(asModWallet(makeDeps()), {
      auth: modCred,
      board: "announcements",
      body: "official update",
      ...fee(),
    });
    expect(r.status).toBe(201);
  });

  it("a non-mod wallet still cannot post to a mod-only board (403)", async () => {
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242";
    const r = await createPost(makeDeps(), {
      author: "alice",
      auth: testCred("alice"),
      board: "announcements",
      body: "not a mod",
      ...fee(),
    });
    expect(r.status).toBe(403);
  });

  it("a mod wallet can create an event with no registered page", async () => {
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242";
    const r = await createEvent(asModWallet(makeDeps()), {
      auth: modCred,
      title: "Town Hall",
      description: "D",
      startsAt: "2026-12-01T18:00:00Z",
    });
    expect(r.status).toBe(201);
  });

  it("a non-mod non-owner still cannot hide (403) and the copy names both paths", async () => {
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242";
    const deps = makeDeps();
    const seq = await postOnBoard(deps, "bob", "hello");
    const r = await submitModAction(deps, {
      author: "alice",
      auth: testCred("alice"),
      targetKind: "post",
      targetSeq: seq,
      board: "general",
    });
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toMatch(/TOWNHALL_MOD_WALLETS/);
  });

  it("getModStatus reports isMod for a mod wallet with no page", async () => {
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242";
    const r = await getModStatus(asModWallet(makeDeps()), { auth: modCred });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ isMod: true, username: MOD_WALLET });
  });
});

describe("mod-status", () => {
  it("reports global-mod status", async () => {
    const r = await getModStatus(makeDeps(), {
      username: "brandon",
      auth: testCred("brandon"),
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ username: "brandon", isMod: true });
  });

  it("reports wall-owner rights for the owner's own wall", async () => {
    const r = await getModStatus(makeDeps(), {
      username: "alice",
      wall: "alice",
      auth: testCred("alice"),
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ isMod: false, canModerateWall: true });
  });

  it("denies wall rights on someone else's wall", async () => {
    const r = await getModStatus(makeDeps(), {
      username: "alice",
      wall: "bob",
      auth: testCred("alice"),
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ isMod: false, canModerateWall: false });
  });

  it("401s without a session", async () => {
    const r = await getModStatus(makeDeps(), { username: "brandon" });
    expect(r.status).toBe(401);
  });
});

describe("free-write quota (429)", () => {
  // Fee-free handlers (votes, rep votes, listing status, mod actions,
  // events) cost the operator an HCS submit each. The per-wallet daily
  // quota keeps them free for humans while bounding spam losses.
  const OLD = process.env.TOWNHALL_WRITE_DAILY_QUOTA;
  afterEach(async () => {
    if (OLD === undefined) delete process.env.TOWNHALL_WRITE_DAILY_QUOTA;
    else process.env.TOWNHALL_WRITE_DAILY_QUOTA = OLD;
    await globalQuotaStore().clearAll();
  });

  it("voteProposal 429s once the daily free-write quota is exhausted", async () => {
    process.env.TOWNHALL_WRITE_DAILY_QUOTA = "3";
    await globalQuotaStore().clearAll();
    const deps = makeDeps();
    const body = () => ({ voter: "bob", auth: testCred("bob"), choice: "yes" });
    for (let i = 0; i < 3; i++) {
      const r = await voteProposal(deps, "p1", body());
      expect(r.status).toBe(200);
    }
    const r = await voteProposal(deps, "p1", body());
    expect(r.status).toBe(429);
    const j = r.json as Record<string, unknown>;
    expect(j.limit).toBe(3);
    expect(typeof j.resetsAt).toBe("string");
    expect(String(j.error)).toMatch(/quota exceeded/);
  });

  it("TOWNHALL_WRITE_DAILY_QUOTA=0 denies all free writes", async () => {
    process.env.TOWNHALL_WRITE_DAILY_QUOTA = "0";
    await globalQuotaStore().clearAll();
    const r = await voteProposal(makeDeps(), "p1", {
      voter: "bob",
      auth: testCred("bob"),
      choice: "yes",
    });
    expect(r.status).toBe(429);
  });

  it("quota is per-wallet: exhausting one wallet does not block another", async () => {
    process.env.TOWNHALL_WRITE_DAILY_QUOTA = "1";
    await globalQuotaStore().clearAll();
    const deps = makeDeps();
    const r1 = await voteProposal(deps, "p1", { voter: "bob", auth: testCred("bob"), choice: "yes" });
    expect(r1.status).toBe(200);
    const r2 = await voteProposal(deps, "p1", { voter: "bob", auth: testCred("bob"), choice: "yes" });
    expect(r2.status).toBe(429);
    const r3 = await voteProposal(deps, "p1", { voter: "alice", auth: testCred("alice"), choice: "yes" });
    expect(r3.status).toBe(200);
  });
});

describe("safety filter (pre-publish)", () => {
  it("blocks a chat message with a violent threat before the dust fee", async () => {
    const deps = makeDeps();
    const r = await postChat(deps, "lobby", {
      author: "alice",
      auth: testCred("alice"),
      body: "i will kill you tomorrow",
      ...fee(),
    });
    expect(r.status).toBe(400);
    expect(String((r.json as Record<string, unknown>).error)).toContain("threats of violence");
    // Nothing reached HCS.
    const events = await queryChatMessages(deps, "lobby");
    expect(events).toEqual([]);
  });

  it("blocks a forum post containing an SSN", async () => {
    const deps = makeDeps();
    const r = await createPost(deps, {
      author: "alice",
      auth: testCred("alice"),
      body: "leaked ssn 123-45-6789, enjoy",
      ...fee(),
    });
    expect(r.status).toBe(400);
    expect(String((r.json as Record<string, unknown>).error)).toContain("SSN");
  });

  it("blocks a listing with a payment card number in the description", async () => {
    const deps = makeDeps();
    const r = await createListing(deps, {
      seller: "0x000000000000000000000000000000000000a11c",
      sellerUsername: "alice",
      auth: testCred("alice"),
      title: "Totally legit sale",
      description: "pay with card 4242 4242 4242 4242",
      priceUsdCents: 100,
      goodsType: "digital",
      ...fee(),
    });
    expect(r.status).toBe(400);
    expect(String((r.json as Record<string, unknown>).error)).toContain("payment card");
  });

  it("blocks a chatroom with terrorist content in the title", async () => {
    const deps = makeDeps();
    const r = await createChatRoom(deps, {
      author: "alice",
      auth: testCred("alice"),
      id: "bad-room",
      title: "join isis fan club",
      description: "a room",
      ...fee(),
    });
    expect(r.status).toBe(400);
    expect(String((r.json as Record<string, unknown>).error)).toContain("terrorist");
  });

  it("lets clean content through all four write paths", async () => {
    const deps = makeDeps();
    const c1 = await postChat(deps, "lobby", { author: "alice", auth: testCred("alice"), body: "hello all", ...fee() });
    const c2 = await createPost(deps, { author: "bob", auth: testCred("bob"), body: "a thoughtful post", ...fee() });
    const c3 = await createListing(deps, {
      seller: "0x000000000000000000000000000000000000a11c",
      sellerUsername: "alice",
      auth: testCred("alice"),
      title: "Sticker pack",
      description: "Cool stickers",
      priceUsdCents: 500,
      goodsType: "physical",
      ...fee(),
    });
    const c4 = await createChatRoom(deps, {
      author: "bob",
      auth: testCred("bob"),
      id: "clean-room",
      title: "Book club",
      description: "We read books",
      ...fee(),
    });
    expect([c1.status, c2.status, c3.status, c4.status]).toEqual([201, 201, 201, 201]);
  });
});

describe("safety reports", () => {
  async function seedPost(deps: TownhallDeps) {
    const r = await createPost(deps, { author: "alice", auth: testCred("alice"), body: "a post", ...fee() });
    expect(r.status).toBe(201);
    return (r.json as { seq: number }).seq;
  }

  it("requires a session", async () => {
    const r = await submitReport(makeDeps(), {
      targetKind: "post",
      targetSeq: 1,
      reason: "this is a sufficiently long reason",
    });
    expect(r.status).toBe(401);
  });

  it("validates targetKind and reason length", async () => {
    const deps = makeDeps();
    const bad1 = await submitReport(deps, { auth: testCred("bob"), targetKind: "nope", targetSeq: 1, reason: "long enough reason here" });
    expect(bad1.status).toBe(400);
    const bad2 = await submitReport(deps, { auth: testCred("bob"), targetKind: "post", targetSeq: 1, reason: "short" });
    expect(bad2.status).toBe(400);
  });

  it("404s when the target does not exist", async () => {
    const r = await submitReport(makeDeps(), {
      auth: testCred("bob"),
      targetKind: "post",
      targetSeq: 999,
      reason: "this post does not exist but the reason is long",
    });
    expect(r.status).toBe(404);
  });

  it("files a report on a post and a chat message (free, no dust fee)", async () => {
    const deps = makeDeps();
    const seq = await seedPost(deps);
    const chat = await postChat(deps, "lobby", { author: "alice", auth: testCred("alice"), body: "hi", ...fee() });
    const chatSeq = (chat.json as { seq: number }).seq;
    // No dustFeeTxId supplied — reports are free.
    const r1 = await submitReport(deps, {
      auth: testCred("bob"),
      reporter: "bob",
      targetKind: "post",
      targetSeq: seq,
      reason: "this post contains harassment targeting another user",
    });
    const r2 = await submitReport(deps, {
      auth: testCred("alice"),
      targetKind: "chat",
      targetSeq: chatSeq,
      reason: "spam links in the lobby, please review this message",
    });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
  });

  it("files a report on a listing by targetId", async () => {
    const deps = makeDeps();
    const l = await createListing(deps, {
      seller: "0x000000000000000000000000000000000000a11c",
      sellerUsername: "alice",
      auth: testCred("alice"),
      title: "Gadget",
      description: "A gadget",
      priceUsdCents: 100,
      goodsType: "digital",
      ...fee(),
    });
    const id = (l.json as { id: string }).id;
    const r = await submitReport(deps, {
      auth: testCred("bob"),
      targetKind: "listing",
      targetId: id,
      reason: "this listing looks like a scam, seller never delivers",
    });
    expect(r.status).toBe(201);
    const missing = await submitReport(deps, {
      auth: testCred("bob"),
      targetKind: "listing",
      targetId: "nope-123",
      reason: "this listing does not exist but reason is long enough",
    });
    expect(missing.status).toBe(404);
  });

  it("report reasons ARE run through the content filter (no quoting blocked text to HCS)", async () => {
    const deps = makeDeps();
    const seq = await seedPost(deps);
    // Verbatim blocked text may not be quoted into an immutable HCS record —
    // reporters paraphrase instead; the targetSeq points mods at the original.
    const blocked = await submitReport(deps, {
      auth: testCred("bob"),
      targetKind: "post",
      targetSeq: seq,
      reason: "the post says 'i will kill you' which is a violent threat",
    });
    expect(blocked.status).toBe(400);
    const ok = await submitReport(deps, {
      auth: testCred("bob"),
      targetKind: "post",
      targetSeq: seq,
      reason: "the post contains a violent threat against another user, please review",
    });
    expect(ok.status).toBe(201);
  });

  it("queryReports is mod-only and lists reports newest-first", async () => {
    const deps = makeDeps();
    const seq = await seedPost(deps);
    await submitReport(deps, {
      auth: testCred("bob"),
      targetKind: "post",
      targetSeq: seq,
      reason: "first report filed against this post for review",
    });
    await submitReport(deps, {
      auth: testCred("alice"),
      reporter: "alice",
      targetKind: "post",
      targetSeq: seq,
      reason: "second report filed against this post for review",
    });

    // Non-mod is rejected.
    const denied = await queryReports(deps, { auth: testCred("bob"), username: "bob" });
    expect(denied.status).toBe(403);
    // TOWNHALL_MODS=brandon in the test env.
    const q = await queryReports(deps, { auth: testCred("brandon"), username: "brandon" });
    expect(q.status).toBe(200);
    const reports = (q.json as { reports: { targetKind: string; targetSeq: number; reporter: string; reason: string }[] }).reports;
    expect(reports.length).toBe(2);
    const reporters = reports.map((r) => r.reporter).sort();
    expect(reporters).toEqual(["0x00000000000000000000000000000000000000b0", "alice"].sort()); // bob's wallet: no username claimed
    for (const r of reports) {
      expect(r).toMatchObject({ targetKind: "post", targetSeq: seq });
      expect(r.reason.length).toBeGreaterThanOrEqual(10);
    }
  });
});

describe("market search (public agent API)", () => {
  let deps: TownhallDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await createListing(deps, {
      seller: OWNERS.alice,
      sellerUsername: "alice",
      auth: testCred("alice"),
      title: "Pixel art commission",
      description: "Custom pixel art avatar",
      priceUsdCents: 2000,
      goodsType: "digital",
      ...fee(),
    });
    await createListing(deps, {
      seller: OWNERS.bob,
      sellerUsername: "bob",
      auth: testCred("bob"),
      title: "Vintage synth",
      description: "Analog synthesizer, great condition",
      priceUsdCents: 45000,
      goodsType: "physical",
      ...fee(),
    });
  });

  it("returns active listings with deep-link urls, no auth needed", async () => {
    const r = await searchListings(deps, {}, "https://voicescape.vercel.app");
    expect(r.status).toBe(200);
    const { listings, count } = r.json as { listings: { url: string; status: string }[]; count: number };
    expect(count).toBe(2);
    for (const l of listings) {
      expect(l.status).toBe("active");
      expect(l.url).toMatch(/^https:\/\/voicescape\.vercel\.app\/marketplace\//);
    }
  });

  it("filters by text query, category, and price range", async () => {
    const q = await searchListings(deps, { q: "synth" }, "https://x.test");
    expect((q.json as { count: number }).count).toBe(1);

    const cat = await searchListings(deps, { category: "digital" }, "https://x.test");
    const catJson = cat.json as { listings: { title: string }[] };
    expect(catJson.listings.length).toBe(1);
    expect(catJson.listings[0].title).toBe("Pixel art commission");

    const cheap = await searchListings(deps, { maxPriceCents: 5000 }, "https://x.test");
    expect((cheap.json as { count: number }).count).toBe(1);

    const pricey = await searchListings(deps, { minPriceCents: 10000 }, "https://x.test");
    expect((pricey.json as { count: number }).count).toBe(1);
  });

  it("sorts by price and excludes sold listings", async () => {
    const { id } = (await createListing(deps, {
      seller: OWNERS.alice,
      sellerUsername: "alice",
      auth: testCred("alice"),
      title: "Cheap sticker",
      description: "A sticker",
      priceUsdCents: 100,
      goodsType: "digital",
      ...fee(),
    })).json as { id: string };
    await setListingStatus(deps, id, { sellerUsername: "alice", auth: testCred("alice"), status: "sold" });

    const asc = await searchListings(deps, { sort: "price-asc" }, "https://x.test");
    const listings = (asc.json as { listings: { priceUsdCents: number }[] }).listings;
    expect(listings.length).toBe(2); // sold one excluded
    expect(listings[0].priceUsdCents).toBeLessThanOrEqual(listings[1].priceUsdCents);

    const desc = await searchListings(deps, { sort: "price-desc" }, "https://x.test");
    const dlist = (desc.json as { listings: { priceUsdCents: number }[] }).listings;
    expect(dlist[0].priceUsdCents).toBeGreaterThanOrEqual(dlist[1].priceUsdCents);
  });

  it("caps limit at 100", async () => {
    const r = await searchListings(deps, { limit: 500 }, "https://x.test");
    expect(r.status).toBe(200);
  });
});

describe("profile links (cross-platform identity)", () => {
  let deps: TownhallDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("sets and reads links for the page owner", async () => {
    const set = await setProfileLinks(deps, {
      username: "alice",
      auth: testCred("alice"),
      links: { twitter: "@alice", website: "https://alice.example" },
    });
    expect(set.status).toBe(201);

    const get = await getProfileLinks(deps, "alice");
    expect(get.status).toBe(200);
    const view = get.json as { username: string; links: Record<string, string> };
    expect(view.username).toBe("alice");
    expect(view.links).toEqual({ twitter: "@alice", website: "https://alice.example" });
  });

  it("latest write wins", async () => {
    await setProfileLinks(deps, { username: "alice", auth: testCred("alice"), links: { twitter: "@old" } });
    await setProfileLinks(deps, { username: "alice", auth: testCred("alice"), links: { twitter: "@new" } });
    const get = await getProfileLinks(deps, "ALICE");
    expect((get.json as { links: Record<string, string> }).links).toEqual({ twitter: "@new" });
  });

  it("rejects non-owners, bad keys, and oversized values", async () => {
    const notOwner = await setProfileLinks(deps, {
      username: "alice",
      auth: testCred("bob"),
      links: { twitter: "@bob" },
    });
    expect(notOwner.status).toBe(403);

    const badKey = await setProfileLinks(deps, {
      username: "alice",
      auth: testCred("alice"),
      links: { "evil key!": "x" },
    });
    expect(badKey.status).toBe(400);

    const tooLong = await setProfileLinks(deps, {
      username: "alice",
      auth: testCred("alice"),
      links: { website: "https://" + "x".repeat(300) },
    });
    expect(tooLong.status).toBe(400);

    const notObject = await setProfileLinks(deps, {
      username: "alice",
      auth: testCred("alice"),
      links: ["nope"],
    });
    expect(notObject.status).toBe(400);
  });

  it("returns empty links for unknown users", async () => {
    const get = await getProfileLinks(deps, "nobody");
    expect(get.status).toBe(200);
    expect((get.json as { links: Record<string, string> }).links).toEqual({});
  });

  it("requires a session", async () => {
    const r = await setProfileLinks(deps, { username: "alice", links: { twitter: "@x" } });
    expect(r.status).toBe(401);
  });
});

describe("referrals (growth loop)", () => {
  let deps: TownhallDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("records a referral and reads stats", async () => {
    const r = await recordReferral(deps, {
      referredUsername: "alice",
      referrer: "brandon",
      auth: testCred("alice"),
    });
    expect(r.status).toBe(201);

    const stats = await getReferralStats(deps, "brandon");
    expect(stats.status).toBe(200);
    const view = stats.json as { username: string; totalReferrals: number; referredUsernames: string[] };
    expect(view.username).toBe("brandon");
    expect(view.totalReferrals).toBe(1);
    expect(view.referredUsernames).toEqual(["alice"]);
  });

  it("rejects self-referrals", async () => {
    const r = await recordReferral(deps, {
      referredUsername: "alice",
      referrer: "alice",
      auth: testCred("alice"),
    });
    expect(r.status).toBe(400);
  });

  it("rejects duplicate referrals (first wins)", async () => {
    const first = await recordReferral(deps, {
      referredUsername: "alice",
      referrer: "brandon",
      auth: testCred("alice"),
    });
    expect(first.status).toBe(201);
    const dup = await recordReferral(deps, {
      referredUsername: "alice",
      referrer: "bob",
      auth: testCred("alice"),
    });
    expect(dup.status).toBe(400);
  });

  it("rejects unregistered referrers", async () => {
    const r = await recordReferral(deps, {
      referredUsername: "alice",
      referrer: "ghost",
      auth: testCred("alice"),
    });
    expect(r.status).toBe(403);
  });

  it("rejects non-owners and requires a session", async () => {
    const notOwner = await recordReferral(deps, {
      referredUsername: "alice",
      referrer: "brandon",
      auth: testCred("bob"),
    });
    expect(notOwner.status).toBe(403);

    const noSession = await recordReferral(deps, {
      referredUsername: "alice",
      referrer: "brandon",
    });
    expect(noSession.status).toBe(401);
  });

  it("returns empty stats for users with no referrals", async () => {
    const stats = await getReferralStats(deps, "carol");
    expect(stats.status).toBe(200);
    const view = stats.json as { totalReferrals: number; referredUsernames: string[] };
    expect(view.totalReferrals).toBe(0);
    expect(view.referredUsernames).toEqual([]);
  });

  it("collectReferralCounts dedupes by referred user (first wins)", async () => {
    await recordReferral(deps, { referredUsername: "alice", referrer: "brandon", auth: testCred("alice") });
    await recordReferral(deps, { referredUsername: "bob", referrer: "brandon", auth: testCred("bob") });
    const messages = await deps.hcs.queryAll("0.0.7001");
    const counts = collectReferralCounts(messages);
    expect(counts.get("brandon")).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Production audit: enforcement + safety on every write path          */
/*                                                                     */
/* Regression tests for the audit fixes: every write path must run    */
/* the graduated-enforcement check and the pre-publish safety filter   */
/* BEFORE any fee is charged or any HCS write happens.                */
/* ------------------------------------------------------------------ */

describe("audit: enforcement + safety gates on all write paths", () => {
  const FORUM = "0.0.7001";
  const THREAT = "I will kill everyone in this chat";

  /** Permanently ban a wallet by writing a ban record to the forum topic. */
  async function banWallet(deps: TownhallDeps, wallet: string) {
    await deps.hcs.submit(FORUM, {
      v: 1,
      kind: "ban",
      ts: new Date().toISOString(),
      author: "brandon",
      wallet: wallet.toLowerCase(),
      username: null,
      reason: "audit fixture ban",
      bannedBy: "brandon",
      expiresAt: null,
    });
  }

  const ALICE_WALLET = "0x000000000000000000000000000000000000a11c";
  const BOB_WALLET = "0x00000000000000000000000000000000000000b0";

  it("createProposal: banned wallet is blocked BEFORE the dust fee", async () => {
    const deps = makeDeps();
    await banWallet(deps, ALICE_WALLET);
    const r = await createProposal(deps, {
      author: "alice",
      auth: testCred("alice"),
      title: "A proposal",
      body: "Some body text",
      closesAt: "2027-01-01T00:00:00Z",
      ...fee(),
    });
    expect(r.status).toBe(403);
  });

  it("createProposal: unsafe title/body is blocked BEFORE the dust fee", async () => {
    const deps = makeDeps();
    const r = await createProposal(deps, {
      author: "alice",
      auth: testCred("alice"),
      title: THREAT,
      body: "Some body text",
      closesAt: "2027-01-01T00:00:00Z",
      ...fee(),
    });
    expect(r.status).toBe(400);
    const r2 = await createProposal(deps, {
      author: "alice",
      auth: testCred("alice"),
      title: "Fine title",
      body: THREAT,
      closesAt: "2027-01-01T00:00:00Z",
      ...fee(),
    });
    expect(r2.status).toBe(400);
  });

  it("castRepVote: banned wallet cannot cast reputation votes", async () => {
    const deps = makeDeps({ purchases: [["alice", "bob"]] });
    await banWallet(deps, ALICE_WALLET);
    const r = await castRepVote(deps, {
      target: "bob",
      voter: "alice",
      auth: testCred("alice"),
      value: 1,
    });
    expect(r.status).toBe(403);
  });

  it("voteProposal: banned wallet cannot vote on proposals", async () => {
    const deps = makeDeps();
    const created = await createProposal(deps, {
      author: "brandon",
      auth: testCred("brandon"),
      title: "Should we?",
      body: "A question",
      closesAt: "2027-01-01T00:00:00Z",
      ...fee(),
    });
    expect(created.status).toBe(201);
    const id = (created.json as { id: string }).id;
    await banWallet(deps, ALICE_WALLET);
    const r = await voteProposal(deps, id, {
      voter: "alice",
      auth: testCred("alice"),
      choice: "yes",
    });
    expect(r.status).toBe(403);
  });

  it("createEvent: unsafe title/description is blocked", async () => {
    const deps = makeDeps();
    const r = await createEvent(deps, {
      author: "brandon",
      auth: testCred("brandon"),
      title: THREAT,
      description: "A meetup",
      startsAt: "2027-01-01T18:00:00Z",
    });
    expect(r.status).toBe(400);
    const r2 = await createEvent(deps, {
      author: "brandon",
      auth: testCred("brandon"),
      title: "Town hall",
      description: THREAT,
      startsAt: "2027-01-01T18:00:00Z",
    });
    expect(r2.status).toBe(400);
  });

  it("submitReport: unsafe reason text is blocked", async () => {
    const deps = makeDeps();
    const p = await createPost(deps, {
      author: "alice",
      auth: testCred("alice"),
      body: "a post",
      ...fee(),
    });
    expect(p.status).toBe(201);
    const seq = (p.json as { seq: number }).seq;
    const r = await submitReport(deps, {
      auth: testCred("bob"),
      targetKind: "post",
      targetSeq: seq,
      reason: `reporting this because ${THREAT.toLowerCase()} — please review`,
    });
    expect(r.status).toBe(400);
  });

  it("submitAppeal: banned wallets CAN appeal, but unsafe appeal text is blocked", async () => {
    const deps = makeDeps();
    await banWallet(deps, BOB_WALLET);
    // A banned wallet must be able to appeal — no restriction check here.
    const ok = await submitAppeal(deps, {
      auth: testCred("bob"),
      reason: "I believe this ban was a mistake and I would like a second review of my case",
    });
    expect(ok.status).toBe(201);

    // A second banned wallet with abusive appeal text is blocked by the filter.
    await banWallet(deps, ALICE_WALLET);
    const blocked = await submitAppeal(deps, {
      auth: testCred("alice"),
      reason: `appealing because ${THREAT.toLowerCase()} if you do not lift this`,
    });
    expect(blocked.status).toBe(400);
  });
});

describe("stream queries (windowed, for SSE)", () => {
  it("queryPostViews returns only posts after the cursor, filtered by board", async () => {
    const deps = makeDeps();
    const mk = (board: string, body: string) =>
      createPost(deps, { author: "alice", auth: testCred("alice"), board, body, ...fee() });
    expect((await mk("general", "one")).status).toBe(201);
    expect((await mk("general", "two")).status).toBe(201);
    expect((await mk("help", "three")).status).toBe(201);

    const all = await queryPostViews(deps, null, 0);
    expect(all.map((p) => p.body)).toEqual(["one", "two", "three"]);
    expect(all[0]).toMatchObject({ board: "general", author: "alice", seq: 1 });

    const general = await queryPostViews(deps, "general", 0);
    expect(general.map((p) => p.body)).toEqual(["one", "two"]);

    const afterOne = await queryPostViews(deps, null, 1);
    expect(afterOne.map((p) => p.seq)).toEqual([2, 3]);
  });

  it("queryProposalEvents emits proposal and vote events with the proposal id", async () => {
    const deps = makeDeps();
    const created = await createProposal(deps, {
      author: "alice",
      auth: testCred("alice"),
      title: "Fund the fountain",
      body: "Build it.",
      closesAt: "2026-12-01T00:00:00Z",
      ...fee(),
    });
    const id = (created.json as { id: string }).id;
    await voteProposal(deps, id, { voter: "bob", auth: testCred("bob"), choice: "yes" });

    const events = await queryProposalEvents(deps, 0);
    expect(events).toEqual([
      { seq: 1, kind: "proposal", id },
      { seq: 2, kind: "proposal-vote", id },
    ]);
    expect(await queryProposalEvents(deps, 1)).toEqual([{ seq: 2, kind: "proposal-vote", id }]);
    expect(await queryProposalEvents(deps, 99)).toEqual([]);
  });

  it("queryListingViews returns listing views with seq for cursor tracking", async () => {
    const deps = makeDeps();
    const r = await createListing(deps, {
      seller: "0x000000000000000000000000000000000000a11c",
      sellerUsername: "alice",
      auth: testCred("alice"),
      title: "Sticker pack",
      description: "Cool stickers",
      priceUsdCents: 500,
      goodsType: "physical",
      ...fee(),
    });
    expect(r.status).toBe(201);

    const views = await queryListingViews(deps, 0);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ seq: 1, title: "Sticker pack", sellerUsername: "alice", status: "active" });
    expect(await queryListingViews(deps, 1)).toEqual([]);
  });
});
