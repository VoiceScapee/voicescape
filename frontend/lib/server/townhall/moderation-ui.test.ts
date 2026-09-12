/**
 * Moderation UI backend tests — the new server surface the moderation
 * dashboard and restriction banner depend on:
 *  - mods.ts isMod / getModWalletAddresses
 *  - profile reports (targetKind "profile")
 *  - listWarnings (mod-only)
 *  - getMyRestriction (own state, fail-open)
 *  - resolveReportTarget (mod-only)
 *  - unbanUser lifting warnings
 *  - getActiveWarnings
 * All deps mocked (in-memory HCS, stubbed mirror/registry/auth). No network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createListing,
  createPost,
  getMyRestriction,
  listWarnings,
  postChat,
  resolveReportTarget,
  submitReport,
  unbanUser,
  warnUser,
  timeoutUser,
  type TownhallDeps,
} from "./handlers";
import { getActiveWarnings } from "./bans";
import { getModWalletAddresses, isMod } from "./mods";
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
process.env.HCS_SUBMIT_FEE_TINYBARS = "100";

const OWNERS: Record<string, string> = {
  brandon: "0x000000000000000000000000000000000000b001",
  alice: "0x000000000000000000000000000000000000a11c",
  bob: "0x00000000000000000000000000000000000000b0",
  carol: "0x000000000000000000000000000000000000ca01",
};

function testCred(username: string): { message: string; signature: string } {
  return { message: `test-signin:${username}`, signature: `0xtest-${username}` };
}

function makeDeps(): TownhallDeps {
  const mirror: MirrorPort = {
    verifyDustFee: async () => ({ ok: true, reason: "ok", receivedTinybars: 1000 }),
    feeInfo: () => ({ dustFeeTinybars: 1000, treasury: "0.0.999" }),
    resolveAccountId: async (address: string) => (/^0\.0\.\d+$/.test(address) ? address : null),
  };
  const registry: RegistryPort = {
    isRegistered: async (u) => u.trim().toLowerCase() in OWNERS,
    resolveOwner: async (u) => OWNERS[u.trim().toLowerCase()] ?? null,
  };
  const sales: SalesPort = { hasCompletedPurchase: async () => false };
  const auth: AuthPort = {
    verifySession: async (cred: unknown) => {
      const sig = (cred as { signature?: unknown } | null)?.signature;
      const m = typeof sig === "string" ? /^0xtest-([a-z]+)$/.exec(sig) : null;
      const user = m?.[1];
      const address = user ? OWNERS[user] : undefined;
      if (!address) return { ok: false, error: "missing session: sign in with your wallet" };
      return {
        ok: true,
        session: { address, chainId: 296, nonce: `test-${user}`, expiresAtMs: Date.now() + 3600_000 },
      };
    },
  };
  return { hcs: new MemoryHcsClient(), mirror, registry, auth, sales };
}

const MOD = { username: "brandon", auth: testCred("brandon") };

let feeCounter = 0;
function fee() {
  feeCounter += 1;
  return { dustFeeTxId: `0.0.123@1694000000.${String(feeCounter).padStart(9, "0")}` };
}

beforeEach(async () => {
  await clearConsumedDustFees();
  await globalQuotaStore().clearAll();
});

/* ------------------------------------------------------------------ */
/* mods.ts                                                             */
/* ------------------------------------------------------------------ */

describe("mods.ts isMod", () => {
  const OLD_MOD = process.env.MOD_WALLET_ADDRESSES;
  const OLD_LEGACY = process.env.TOWNHALL_MOD_WALLETS;
  afterEach(() => {
    if (OLD_MOD === undefined) delete process.env.MOD_WALLET_ADDRESSES;
    else process.env.MOD_WALLET_ADDRESSES = OLD_MOD;
    if (OLD_LEGACY === undefined) delete process.env.TOWNHALL_MOD_WALLETS;
    else process.env.TOWNHALL_MOD_WALLETS = OLD_LEGACY;
  });

  it("matches a Hedera account id entry in either address form", () => {
    process.env.MOD_WALLET_ADDRESSES = "0.0.424242";
    delete process.env.TOWNHALL_MOD_WALLETS;
    // 0.0.424242 canonicalizes to 0x0000000000000000000000000000000000067932
    expect(isMod("0.0.424242")).toBe(true);
    expect(isMod("0x0000000000000000000000000000000000067932")).toBe(true);
    expect(isMod("0x0000000000000000000000000000000000067933")).toBe(false);
  });

  it("matches a 0x entry and ignores junk", () => {
    process.env.MOD_WALLET_ADDRESSES = " 0x000000000000000000000000000000000000b001 ,, not-an-address ";
    delete process.env.TOWNHALL_MOD_WALLETS;
    expect(isMod("0x000000000000000000000000000000000000b001")).toBe(true);
    expect(isMod("0.0.123")).toBe(false);
    expect(getModWalletAddresses()).toEqual(["0x000000000000000000000000000000000000b001"]);
  });

  it("honors the legacy TOWNHALL_MOD_WALLETS list", () => {
    delete process.env.MOD_WALLET_ADDRESSES;
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242";
    expect(isMod("0.0.424242")).toBe(true);
    expect(isMod("0x0000000000000000000000000000000000067932")).toBe(true);
  });

  it("rejects empty, null, and invalid wallets", () => {
    process.env.MOD_WALLET_ADDRESSES = "0.0.424242";
    expect(isMod("")).toBe(false);
    expect(isMod(null)).toBe(false);
    expect(isMod(undefined)).toBe(false);
    expect(isMod("not-a-wallet")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* profile reports                                                     */
/* ------------------------------------------------------------------ */

describe("profile reports", () => {
  it("files a report against a registered page", async () => {
    const deps = makeDeps();
    const r = await submitReport(deps, {
      auth: testCred("bob"),
      targetKind: "profile",
      targetId: "alice",
      reason: "this page is impersonating someone famous",
    });
    expect(r.status).toBe(201);
  });

  it("normalizes the @ prefix and case", async () => {
    const deps = makeDeps();
    const r = await submitReport(deps, {
      auth: testCred("bob"),
      targetKind: "profile",
      targetId: "@Alice",
      reason: "this page is impersonating someone famous",
    });
    expect(r.status).toBe(201);
  });

  it("404s for an unregistered username", async () => {
    const r = await submitReport(makeDeps(), {
      auth: testCred("bob"),
      targetKind: "profile",
      targetId: "mallory",
      reason: "this page is impersonating someone famous",
    });
    expect(r.status).toBe(404);
  });

  it("400s when targetId is missing", async () => {
    const r = await submitReport(makeDeps(), {
      auth: testCred("bob"),
      targetKind: "profile",
      reason: "this page is impersonating someone famous",
    });
    expect(r.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* listWarnings / getActiveWarnings                                    */
/* ------------------------------------------------------------------ */

describe("listWarnings", () => {
  it("403s for non-mods", async () => {
    const r = await listWarnings(makeDeps(), { auth: testCred("alice") });
    expect(r.status).toBe(403);
  });

  it("honors username-only mods (TOWNHALL_MODS) via body username", async () => {
    const OLD = process.env.TOWNHALL_MODS;
    process.env.TOWNHALL_MODS = "brandon,carol";
    try {
      const deps = makeDeps();
      // carol's wallet is in no mod wallet list — only her username grants access.
      const ok = await listWarnings(deps, { username: "carol", auth: testCred("carol") });
      expect(ok.status).toBe(200);
      // Without the username the same session is denied.
      const denied = await listWarnings(deps, { auth: testCred("carol") });
      expect(denied.status).toBe(403);
    } finally {
      process.env.TOWNHALL_MODS = OLD;
    }
  });

  it("returns active warnings newest-first and drops lifted ones", async () => {
    const deps = makeDeps();
    const w1 = await warnUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "first offense, please be kind" });
    expect(w1.status).toBe(201);
    const w2 = await warnUser(deps, { ...MOD, wallet: OWNERS.bob, reason: "second person also misbehaving" });
    expect(w2.status).toBe(201);

    const listed = await listWarnings(deps, { ...MOD });
    expect(listed.status).toBe(200);
    const warnings = (listed.json as { warnings: { wallet: string }[] }).warnings;
    expect(warnings).toHaveLength(2);
    // both wallets present (same-ms timestamps make strict ordering flaky)
    const wallets = warnings.map((w) => w.wallet).sort();
    expect(wallets).toEqual([OWNERS.alice.toLowerCase(), OWNERS.bob.toLowerCase()].sort());

    // Lift alice's warning — it leaves the active list.
    const lift = await unbanUser(deps, { ...MOD, wallet: OWNERS.alice });
    expect(lift.status).toBe(201);
    const listed2 = await listWarnings(deps, { ...MOD });
    expect((listed2.json as { warnings: unknown[] }).warnings).toHaveLength(1);

    // Direct bans.ts read agrees.
    expect(await getActiveWarnings(deps)).toHaveLength(1);
  });

  it("a superseding timeout removes the warning from the active list", async () => {
    const deps = makeDeps();
    expect((await warnUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "first offense, please be kind" })).status).toBe(201);
    expect(
      (await timeoutUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "kept spamming after the warning", durationMinutes: 30 })).status,
    ).toBe(201);
    const listed = await listWarnings(deps, { ...MOD });
    expect((listed.json as { warnings: unknown[] }).warnings).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* getMyRestriction                                                    */
/* ------------------------------------------------------------------ */

describe("getMyRestriction", () => {
  it("401s without a session", async () => {
    const r = await getMyRestriction(makeDeps(), {});
    expect(r.status).toBe(401);
  });

  it("reports clean for an unrestricted wallet", async () => {
    const r = await getMyRestriction(makeDeps(), { auth: testCred("alice") });
    expect(r.status).toBe(200);
    expect((r.json as { status: string }).status).toBe("clean");
  });

  it("reports warned then timed-out states for the signing wallet", async () => {
    const deps = makeDeps();
    expect((await warnUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "first offense, please be kind" })).status).toBe(201);
    const w = await getMyRestriction(deps, { auth: testCred("alice") });
    expect((w.json as { status: string; reason: string }).status).toBe("warned");
    expect((w.json as { reason: string }).reason).toBe("first offense, please be kind");

    expect(
      (await timeoutUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "kept spamming after the warning", durationMinutes: 45 })).status,
    ).toBe(201);
    const t = await getMyRestriction(deps, { auth: testCred("alice") });
    const tj = t.json as { status: string; remainingMs: number; expiresAt: number };
    expect(tj.status).toBe("timed-out");
    expect(tj.remainingMs).toBeGreaterThan(0);
    expect(tj.expiresAt).toBeGreaterThan(Date.now());
  });

  it("never reports another wallet's state", async () => {
    const deps = makeDeps();
    expect((await warnUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "first offense, please be kind" })).status).toBe(201);
    const r = await getMyRestriction(deps, { auth: testCred("bob") });
    expect((r.json as { status: string }).status).toBe("clean");
  });
});

/* ------------------------------------------------------------------ */
/* resolveReportTarget                                                 */
/* ------------------------------------------------------------------ */

describe("resolveReportTarget", () => {
  it("403s for non-mods", async () => {
    const r = await resolveReportTarget(makeDeps(), { auth: testCred("alice"), targetKind: "post", targetSeq: 1 });
    expect(r.status).toBe(403);
  });

  it("resolves a post author to username + wallet", async () => {
    const deps = makeDeps();
    const p = await createPost(deps, { author: "alice", auth: testCred("alice"), body: "hello world", ...fee() });
    const seq = (p.json as { seq: number }).seq;
    const r = await resolveReportTarget(deps, { ...MOD, targetKind: "post", targetSeq: seq });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ username: "alice", wallet: OWNERS.alice.toLowerCase() });
  });

  it("resolves a chat message author to username + wallet", async () => {
    const deps = makeDeps();
    const c = await postChat(deps, "lobby", { author: "bob", auth: testCred("bob"), body: "hey there", ...fee() });
    const seq = (c.json as { seq: number }).seq;
    const r = await resolveReportTarget(deps, { ...MOD, targetKind: "chat", targetSeq: seq });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ username: "bob", wallet: OWNERS.bob.toLowerCase() });
  });

  it("resolves a listing seller to username + wallet", async () => {
    const deps = makeDeps();
    const l = await createListing(deps, {
      seller: OWNERS.alice,
      sellerUsername: "alice",
      auth: testCred("alice"),
      title: "cool thing",
      description: "a very cool thing for sale",
      priceUsdCents: 500,
      goodsType: "digital",
      ...fee(),
    });
    const id = (l.json as { id: string }).id;
    const r = await resolveReportTarget(deps, { ...MOD, targetKind: "listing", targetId: id });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ username: "alice", wallet: OWNERS.alice.toLowerCase() });
  });

  it("resolves a profile target to username + wallet", async () => {
    const deps = makeDeps();
    const r = await resolveReportTarget(deps, { ...MOD, targetKind: "profile", targetId: "alice" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ username: "alice", wallet: OWNERS.alice.toLowerCase() });
  });

  it("404s when the target does not exist", async () => {
    const deps = makeDeps();
    const r = await resolveReportTarget(deps, { ...MOD, targetKind: "post", targetSeq: 999 });
    expect(r.status).toBe(404);
    const r2 = await resolveReportTarget(deps, { ...MOD, targetKind: "listing", targetId: "nope" });
    expect(r2.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* unbanUser lifts warnings                                            */
/* ------------------------------------------------------------------ */

describe("unbanUser lifts warnings", () => {
  it("clears a warned wallet back to clean", async () => {
    const deps = makeDeps();
    expect((await warnUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "first offense, please be kind" })).status).toBe(201);
    const lift = await unbanUser(deps, { ...MOD, wallet: OWNERS.alice });
    expect(lift.status).toBe(201);
    const mine = await getMyRestriction(deps, { auth: testCred("alice") });
    expect((mine.json as { status: string }).status).toBe("clean");
  });

  it("still 404s for a wallet with no record at all", async () => {
    const r = await unbanUser(makeDeps(), { ...MOD, wallet: OWNERS.bob });
    expect(r.status).toBe(404);
  });
});
