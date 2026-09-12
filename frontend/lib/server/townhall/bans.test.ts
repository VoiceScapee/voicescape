/**
 * Graduated enforcement tests — pure state machine plus handler
 * integration (in-memory HCS, stubbed mirror/registry/auth). No network.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  banUser,
  createPost,
  listBans,
  postChat,
  queryAppeals,
  resolveAppeal,
  submitAppeal,
  suggestEnforcementAction,
  timeoutUser,
  unbanUser,
  warnUser,
  type TownhallDeps,
} from "./handlers";
import {
  collectEnforcementEvents,
  countOffenses,
  formatRemaining,
  getEnforcementState,
  hasPendingAppeal,
  isRestricted,
  pendingAppeals,
  suggestEnforcement,
  type EnforcementEvent,
} from "./bans";
import { MemoryHcsClient } from "./hcs";
import type { MirrorPort } from "./mirror";
import { clearConsumedDustFees } from "./mirror";
import type { RegistryPort } from "./registry-check";
import type { AuthPort } from "./auth";
import type { SalesPort } from "./sales";
import { globalQuotaStore } from "../quota";
import type {
  AppealMessage,
  AppealResolveMessage,
  BanMessage,
  StoredMessage,
  TimeoutMessage,
  TownhallMessage,
  WarnMessage,
} from "./types";

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
/* Pure helpers for building events                                   */
/* ------------------------------------------------------------------ */

let tsCounter = 0;
function ts(): string {
  tsCounter += 1;
  return new Date(Date.now() + tsCounter).toISOString();
}

function warn(wallet: string, reason = "spam"): WarnMessage {
  return { v: 1, kind: "warn", ts: ts(), author: "brandon", wallet, username: null, reason, warnedBy: "brandon" };
}
function timeout(wallet: string, minutes = 60, reason = "spam"): TimeoutMessage {
  return {
    v: 1, kind: "timeout", ts: ts(), author: "brandon", wallet, username: null,
    reason, timedOutBy: "brandon", durationMinutes: minutes, expiresAt: Date.now() + minutes * 60000,
  };
}
function ban(wallet: string, reason = "abuse", expiresAt: number | null = null): BanMessage {
  return { v: 1, kind: "ban", ts: ts(), author: "brandon", wallet, username: null, reason, bannedBy: "brandon", expiresAt };
}
function ev(e: TownhallMessage): StoredMessage {
  return { seq: 1, topic: "0.0.7001", consensusTimestamp: ts(), contents: e };
}

/* ------------------------------------------------------------------ */
/* State machine                                                      */
/* ------------------------------------------------------------------ */

describe("getEnforcementState", () => {
  const alice = OWNERS.alice;
  it("is clean with no events", () => {
    expect(getEnforcementState(alice, []).status).toBe("clean");
  });
  it("warn does not restrict", () => {
    const s = getEnforcementState(alice, collectEnforcementEvents([ev(warn(alice))]));
    expect(s.status).toBe("warned");
    expect(s.kind).toBe("warn");
  });
  it("active timeout restricts with remaining time", () => {
    const s = getEnforcementState(alice, collectEnforcementEvents([ev(timeout(alice, 60))]));
    expect(s.status).toBe("timed-out");
    expect(s.remainingMs).toBeGreaterThan(0);
    expect(s.expiresAt).toBeGreaterThan(Date.now());
  });
  it("expired timeout is clean", () => {
    const t = timeout(alice, 60);
    t.expiresAt = Date.now() - 1000;
    expect(getEnforcementState(alice, collectEnforcementEvents([ev(t)])).status).toBe("clean");
  });
  it("temp ban and permanent ban", () => {
    expect(getEnforcementState(alice, collectEnforcementEvents([ev(ban(alice, "x", Date.now() + 99999))])).status).toBe(
      "temp-banned",
    );
    expect(getEnforcementState(alice, collectEnforcementEvents([ev(ban(alice))])).status).toBe("banned");
  });
  it("expired temp ban is clean", () => {
    expect(getEnforcementState(alice, collectEnforcementEvents([ev(ban(alice, "x", Date.now() - 1))])).status).toBe(
      "clean",
    );
  });
  it("unban clears a ban (latest wins)", () => {
    const events = collectEnforcementEvents([
      ev(ban(alice)),
      ev({ v: 1, kind: "unban", ts: ts(), author: "brandon", wallet: alice, unbannedBy: "brandon" }),
    ]);
    expect(getEnforcementState(alice, events).status).toBe("clean");
  });
  it("appeal-resolve lifted clears; upheld keeps the ban", () => {
    const b = ban(alice);
    const lifted: AppealResolveMessage = {
      v: 1, kind: "appeal-resolve", ts: ts(), author: "brandon", wallet: alice,
      resolvedBy: "brandon", action: "lifted", note: null,
    };
    expect(getEnforcementState(alice, collectEnforcementEvents([ev(b), ev(lifted)])).status).toBe("clean");
    const upheld: AppealResolveMessage = { ...lifted, ts: ts(), action: "upheld" };
    expect(getEnforcementState(alice, collectEnforcementEvents([ev(b), ev(upheld)])).status).toBe("banned");
  });
  it("latest record wins across kinds", () => {
    const events = collectEnforcementEvents([ev(ban(alice)), ev(warn(alice))]);
    expect(getEnforcementState(alice, events).status).toBe("warned");
  });
  it("ignores other wallets", () => {
    const events = collectEnforcementEvents([ev(ban(OWNERS.bob))]);
    expect(getEnforcementState(alice, events).status).toBe("clean");
  });
});

describe("isRestricted", () => {
  const alice = OWNERS.alice;
  it("false for clean/warned, true for timed-out/temp-banned/banned", () => {
    expect(isRestricted(alice, [])).toBe(false);
    expect(isRestricted(alice, collectEnforcementEvents([ev(warn(alice))]))).toBe(false);
    expect(isRestricted(alice, collectEnforcementEvents([ev(timeout(alice))]))).toBe(true);
    expect(isRestricted(alice, collectEnforcementEvents([ev(ban(alice, "x", Date.now() + 9999))]))).toBe(true);
    expect(isRestricted(alice, collectEnforcementEvents([ev(ban(alice))]))).toBe(true);
  });
});

describe("countOffenses", () => {
  it("counts warn/timeout/ban, ignores unban and resolves", () => {
    const alice = OWNERS.alice;
    const events = collectEnforcementEvents([
      ev(warn(alice)),
      ev(timeout(alice)),
      ev({ v: 1, kind: "unban", ts: ts(), author: "brandon", wallet: alice, unbannedBy: "brandon" }),
      ev(ban(alice)),
    ]);
    expect(countOffenses(alice, events)).toBe(3);
    expect(countOffenses(OWNERS.bob, events)).toBe(0);
  });
});

describe("suggestEnforcement", () => {
  const alice = OWNERS.alice;
  it("escalates low severity across repeat offenses", () => {
    expect(suggestEnforcement(alice, "low", []).recommended).toBe("warn");
    expect(suggestEnforcement(alice, "low", collectEnforcementEvents([ev(warn(alice))])).recommended).toBe("timeout");
    expect(suggestEnforcement(alice, "low", collectEnforcementEvents([ev(warn(alice))])).durationMinutes).toBe(15);
    const two = collectEnforcementEvents([ev(warn(alice)), ev(timeout(alice))]);
    const s3 = suggestEnforcement(alice, "low", two);
    expect(s3.recommended).toBe("temp-ban");
    expect(s3.durationMinutes).toBe(7 * 24 * 60);
    const three = collectEnforcementEvents([ev(warn(alice)), ev(timeout(alice)), ev(ban(alice, "x", Date.now() + 1))]);
    expect(suggestEnforcement(alice, "low", three).recommended).toBe("permanent-ban");
  });
  it("critical jumps to permanent ban regardless of history", () => {
    expect(suggestEnforcement(alice, "critical", []).recommended).toBe("permanent-ban");
    expect(suggestEnforcement(alice, "critical", collectEnforcementEvents([ev(warn(alice))])).recommended).toBe(
      "permanent-ban",
    );
  });
  it("medium and high ladders", () => {
    const m1 = suggestEnforcement(alice, "medium", []);
    expect(m1.recommended).toBe("timeout");
    expect(m1.durationMinutes).toBe(60);
    const h1 = suggestEnforcement(alice, "high", []);
    expect(h1.recommended).toBe("temp-ban");
    expect(h1.durationMinutes).toBe(30 * 24 * 60);
    expect(suggestEnforcement(alice, "high", collectEnforcementEvents([ev(warn(alice))])).recommended).toBe(
      "permanent-ban",
    );
  });
});

describe("formatRemaining", () => {
  it("humanizes durations", () => {
    expect(formatRemaining(42 * 60000)).toBe("42m");
    expect(formatRemaining(3 * 3600000)).toBe("3h");
    expect(formatRemaining(5 * 86400000)).toBe("5d");
  });
});

describe("pendingAppeals", () => {
  const alice = OWNERS.alice;
  const appeal = (w: string): AppealMessage =>
    ({ v: 1, kind: "appeal", ts: ts(), author: w, wallet: w, reason: "I did not spam, please review my case here." }) as AppealMessage;
  it("pending until resolved", () => {
    const a = [appeal(alice)];
    expect(hasPendingAppeal(a, [], alice)).toBe(true);
    const r: AppealResolveMessage[] = [
      { v: 1, kind: "appeal-resolve", ts: ts(), author: "brandon", wallet: alice, resolvedBy: "brandon", action: "upheld", note: null },
    ];
    expect(hasPendingAppeal(a, r, alice)).toBe(false);
    expect(pendingAppeals(a, r)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Handler integration                                                */
/* ------------------------------------------------------------------ */

const MOD = { username: "brandon", auth: testCred("brandon") };

describe("warn/timeout/ban write-path enforcement", () => {
  it("warn does not block writes", async () => {
    const deps = makeDeps();
    const w = await warnUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "first offense, watch it" });
    expect(w.status).toBe(201);
    const r = await postChat(deps, "lobby", { author: "alice", auth: testCred("alice"), body: "hello", ...fee() });
    expect(r.status).toBe(201);
  });

  it("timeout blocks writes with 403 and remaining time", async () => {
    const deps = makeDeps();
    const t = await timeoutUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "spamming the chat", durationMinutes: 60 });
    expect(t.status).toBe(201);
    const r = await postChat(deps, "lobby", { author: "alice", auth: testCred("alice"), body: "hello", ...fee() });
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toMatch(/timed out/);
    expect((r.json as { error: string }).error).toMatch(/remaining/);
    // Another user is unaffected.
    const ok2 = await postChat(deps, "lobby", { author: "bob", auth: testCred("bob"), body: "hi", ...fee() });
    expect(ok2.status).toBe(201);
  });

  it("temp ban blocks with 403", async () => {
    const deps = makeDeps();
    const b = await banUser(deps, {
      ...MOD, wallet: OWNERS.alice, reason: "repeated abuse", expiresAt: Date.now() + 7 * 86400000,
    });
    expect(b.status).toBe(201);
    const r = await createPost(deps, { ...MOD, author: "alice", auth: testCred("alice"), body: "post", ...fee() });
    expect(r.status).toBe(403);
    expect((r.json as { error: string }).error).toMatch(/temporarily banned/);
  });

  it("permanent ban blocks and unban restores", async () => {
    const deps = makeDeps();
    expect((await banUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "severe violation here" })).status).toBe(201);
    expect(
      (await postChat(deps, "lobby", { author: "alice", auth: testCred("alice"), body: "x", ...fee() })).status,
    ).toBe(403);
    const u = await unbanUser(deps, { ...MOD, wallet: OWNERS.alice });
    expect(u.status).toBe(201);
    const r = await postChat(deps, "lobby", { author: "alice", auth: testCred("alice"), body: "back", ...fee() });
    expect(r.status).toBe(201);
  });

  it("expired timeout does not block (integration)", async () => {
    const deps = makeDeps();
    // Inject an already-expired timeout record directly on the forum topic.
    (deps.hcs as MemoryHcsClient).seed("0.0.7001", {
      v: 1,
      kind: "timeout",
      ts: new Date(Date.now() - 7200000).toISOString(),
      author: "brandon",
      wallet: OWNERS.alice,
      username: null,
      reason: "old spam wave",
      timedOutBy: "brandon",
      durationMinutes: 60,
      expiresAt: Date.now() - 3600000,
    });
    const r = await postChat(deps, "lobby", { author: "alice", auth: testCred("alice"), body: "hello again", ...fee() });
    expect(r.status).toBe(201);
  });

  it("ban is mod-only; invalid wallet rejected", async () => {
    const deps = makeDeps();
    const nonMod = await banUser(deps, {
      username: "alice", auth: testCred("alice"), wallet: OWNERS.bob, reason: "trying to ban",
    });
    expect(nonMod.status).toBe(403);
    const bad = await banUser(deps, { ...MOD, wallet: "not-a-wallet", reason: "bad wallet test" });
    expect(bad.status).toBe(400);
    const noAuth = await banUser(deps, { username: "brandon", wallet: OWNERS.bob, reason: "no session here" });
    expect(noAuth.status).toBe(401);
  });

  it("double-ban is rejected with 409", async () => {
    const deps = makeDeps();
    expect((await banUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "first ban reason" })).status).toBe(201);
    const again = await banUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "second ban reason" });
    expect(again.status).toBe(409);
  });

  it("timeout duration validated", async () => {
    const deps = makeDeps();
    const r = await timeoutUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "bad duration", durationMinutes: 999999 });
    expect(r.status).toBe(400);
  });

  it("listBans returns bans and timeouts, mod-only", async () => {
    const deps = makeDeps();
    await banUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "banned for test" });
    await timeoutUser(deps, { ...MOD, wallet: OWNERS.bob, reason: "timed out test", durationMinutes: 30 });
    const q = await listBans(deps, { ...MOD });
    expect(q.status).toBe(200);
    const { bans, timeouts } = q.json as { bans: unknown[]; timeouts: unknown[] };
    expect(bans).toHaveLength(1);
    expect(timeouts).toHaveLength(1);
    const denied = await listBans(deps, { username: "alice", auth: testCred("alice") });
    expect(denied.status).toBe(403);
  });

  it("suggestEnforcementAction is mod-only and validates input", async () => {
    const deps = makeDeps();
    const s = await suggestEnforcementAction(deps, { ...MOD, wallet: OWNERS.alice, severity: "low" });
    expect(s.status).toBe(200);
    const body = s.json as { suggestion: { recommended: string } };
    expect(body.suggestion.recommended).toBe("warn");
    const bad = await suggestEnforcementAction(deps, { ...MOD, wallet: OWNERS.alice, severity: "extreme" });
    expect(bad.status).toBe(400);
    const denied = await suggestEnforcementAction(deps, {
      username: "alice", auth: testCred("alice"), wallet: OWNERS.bob, severity: "low",
    });
    expect(denied.status).toBe(403);
  });
});

describe("appeals", () => {
  const APPEAL_REASON = "I believe this restriction was a mistake and I would like a second review please.";

  it("banned user can appeal; second appeal is 409; clean user gets 400", async () => {
    const deps = makeDeps();
    await banUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "appeal test ban" });
    const a1 = await submitAppeal(deps, { auth: testCred("alice"), reason: APPEAL_REASON });
    expect(a1.status).toBe(201);
    const a2 = await submitAppeal(deps, { auth: testCred("alice"), reason: APPEAL_REASON });
    expect(a2.status).toBe(409);
    // Clean user has nothing to appeal.
    const clean = await submitAppeal(deps, { auth: testCred("bob"), reason: APPEAL_REASON });
    expect(clean.status).toBe(400);
    // Short reason rejected.
    const deps2 = makeDeps();
    await banUser(deps2, { ...MOD, wallet: OWNERS.alice, reason: "appeal test ban 2" });
    const short = await submitAppeal(deps2, { auth: testCred("alice"), reason: "too short" });
    expect(short.status).toBe(400);
  });

  it("timed-out user can appeal too", async () => {
    const deps = makeDeps();
    await timeoutUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "timeout appeal", durationMinutes: 60 });
    const a = await submitAppeal(deps, { auth: testCred("alice"), reason: APPEAL_REASON });
    expect(a.status).toBe(201);
  });

  it("mod appeal queue lists pending; resolve lifted restores writes", async () => {
    const deps = makeDeps();
    await timeoutUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "timeout for appeal", durationMinutes: 60 });
    await submitAppeal(deps, { auth: testCred("alice"), reason: APPEAL_REASON });
    const q = await queryAppeals(deps, { ...MOD });
    expect(q.status).toBe(200);
    const { appeals } = q.json as { appeals: { wallet: string; restriction: { status: string } | null }[] };
    expect(appeals).toHaveLength(1);
    expect(appeals[0].wallet).toBe(OWNERS.alice);
    expect(appeals[0].restriction?.status).toBe("timed-out");
    const denied = await queryAppeals(deps, { username: "alice", auth: testCred("alice") });
    expect(denied.status).toBe(403);

    const res = await resolveAppeal(deps, { ...MOD, wallet: OWNERS.alice, action: "lifted", note: "mistake, sorry" });
    expect(res.status).toBe(201);
    // Restriction cleared — writes work again.
    const r = await postChat(deps, "lobby", { author: "alice", auth: testCred("alice"), body: "appeal won", ...fee() });
    expect(r.status).toBe(201);
    // Appeal no longer pending.
    const q2 = await queryAppeals(deps, { ...MOD });
    expect((q2.json as { appeals: unknown[] }).appeals).toHaveLength(0);
  });

  it("resolve upheld keeps the restriction", async () => {
    const deps = makeDeps();
    await banUser(deps, { ...MOD, wallet: OWNERS.alice, reason: "upheld appeal ban" });
    await submitAppeal(deps, { auth: testCred("alice"), reason: APPEAL_REASON });
    const res = await resolveAppeal(deps, { ...MOD, wallet: OWNERS.alice, action: "upheld" });
    expect(res.status).toBe(201);
    const r = await postChat(deps, "lobby", { author: "alice", auth: testCred("alice"), body: "still banned", ...fee() });
    expect(r.status).toBe(403);
  });

  it("resolve requires a pending appeal", async () => {
    const deps = makeDeps();
    const r = await resolveAppeal(deps, { ...MOD, wallet: OWNERS.alice, action: "lifted" });
    expect(r.status).toBe(404);
  });
});
