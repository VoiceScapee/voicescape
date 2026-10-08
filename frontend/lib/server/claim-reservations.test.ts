/**
 * claim-reservations — unit tests.
 *
 * Converged spec v2: atomic claim-or-reject, nonce decidability, per-key
 * cap, claimant-signed release, funder cap, tombstone row types, renewal,
 * funding-address stability, and declared-txid funding verification.
 * The in-memory backend stands in for Upstash/Valkey; single-command
 * atomicity is a property of the command, which the module already sends
 * as one SET … NX PX (see store.ts).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { PrivateKey } from "@hiero-ledger/sdk";
import {
  reserveHandle,
  getReservation,
  releaseReservation,
  releaseMessage,
  writeTombstone,
  getTombstone,
  deleteReservation,
  deriveFundingAddress,
  normalizeSecp256k1Pubkey,
  pubkeyHash,
  verifyFundingTxid,
  checkFunderCap,
  claimFundingTxid,
  FUNDER_CAP,
  MIN_FUNDING_TINYBAR,
  RESERVATION_TTL_MS,
} from "./claim-reservations";
import { createMemoryKvStore, type KvStore } from "./store";

let store: KvStore;
beforeEach(() => {
  store = createMemoryKvStore();
});

/** Fresh secp256k1 keypair; returns compressed pubkey hex (no 0x). */
function freshKey(): { pub: string; priv: PrivateKey } {
  const priv = PrivateKey.generateECDSA();
  const pub = priv.publicKey.toStringRaw().replace(/^0x/, "").toLowerCase();
  return { pub, priv };
}

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const notFound = { ok: false, status: 404, json: async () => null } as unknown as Response;

describe("reserveHandle — atomic claim-or-reject", () => {
  it("reserves a fresh handle for a key", async () => {
    const { pub } = freshKey();
    const r = await reserveHandle(
      { username: "agentone", claimant_pubkey: pub, nonce: "n1" },
      store,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.existing).toBe(false);
    expect(r.renewed).toBe(false);
    expect(r.reservation.username).toBe("agentone");
    expect(r.reservation.funding_address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(r.reservation.renewals_used).toBe(0);
    expect(r.reservation.expires_at - r.reservation.created_at).toBe(RESERVATION_TTL_MS);
  });

  it("two simultaneous prepares for the same handle → exactly one wins", async () => {
    const a = freshKey();
    const b = freshKey();
    const [ra, rb] = await Promise.all([
      reserveHandle({ username: "racehandle", claimant_pubkey: a.pub, nonce: "na" }, store),
      reserveHandle({ username: "racehandle", claimant_pubkey: b.pub, nonce: "nb" }, store),
    ]);
    const winners = [ra, rb].filter((r) => r.ok);
    const losers = [ra, rb].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (!losers[0].ok) {
      expect(losers[0].error).toMatch(/reserved until .* by another agent/);
      expect(losers[0].error).toMatch(/soft hold, not a lock/);
    }
  });

  it("idempotent re-prepare: same key + handle returns the existing reservation", async () => {
    const { pub } = freshKey();
    const first = await reserveHandle(
      { username: "idempotent", claimant_pubkey: pub, nonce: "n1" },
      store,
    );
    expect(first.ok).toBe(true);
    const second = await reserveHandle(
      { username: "idempotent", claimant_pubkey: pub, nonce: "n2-different" },
      store,
    );
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.existing).toBe(true);
    expect(second.reservation.reservation_id).toBe(first.reservation.reservation_id);
  });

  it("rejects ed25519-shaped keys", async () => {
    const r = await reserveHandle(
      { username: "badkey", claimant_pubkey: "a".repeat(64), nonce: "n1" },
      store,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ED25519/i);
  });

  it("rejects missing nonce", async () => {
    const { pub } = freshKey();
    const r = await reserveHandle({ username: "nononce", claimant_pubkey: pub, nonce: "" }, store);
    expect(r.ok).toBe(false);
  });
});

describe("nonce decidability (lost-response read)", () => {
  it("GET after a lost response: our nonce present = we won", async () => {
    const { pub } = freshKey();
    // Simulate: SET succeeded server-side, response was lost.
    const r = await reserveHandle(
      { username: "lostresp", claimant_pubkey: pub, nonce: "my-nonce-123" },
      store,
    );
    expect(r.ok).toBe(true);
    // The "retry" path: re-prepare returns the existing reservation…
    const retry = await reserveHandle(
      { username: "lostresp", claimant_pubkey: pub, nonce: "other-nonce" },
      store,
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    // …and a direct read shows OUR nonce — decidable.
    const live = await getReservation("lostresp", store);
    expect(live?.nonce).toBe("my-nonce-123");
    expect(live?.reservation_id).toBe(retry.reservation.reservation_id);
  });

  it("foreign nonce on read = we lost", async () => {
    const a = freshKey();
    const b = freshKey();
    await reserveHandle({ username: "contested", claimant_pubkey: a.pub, nonce: "a-nonce" }, store);
    const live = await getReservation("contested", store);
    // B's nonce is nowhere in the record → B lost. Decidable without trust.
    expect(live?.nonce).not.toBe("b-nonce");
    expect(live?.pubkey_hash).toBe(pubkeyHash(a.pub.toLowerCase()));
    expect(live?.pubkey_hash).not.toBe(pubkeyHash(b.pub.toLowerCase()));
  });
});

describe("per-claimant-key cap", () => {
  it("one active reservation per key; second handle rejected", async () => {
    const { pub } = freshKey();
    const first = await reserveHandle(
      { username: "firsthold", claimant_pubkey: pub, nonce: "n1" },
      store,
    );
    expect(first.ok).toBe(true);
    const second = await reserveHandle(
      { username: "secondhold", claimant_pubkey: pub, nonce: "n2" },
      store,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toMatch(/one active reservation per claimant key/);
      expect(second.error).toMatch(/firsthold/);
    }
    // The rolled-back handle is free again for others.
    const other = freshKey();
    const third = await reserveHandle(
      { username: "secondhold", claimant_pubkey: other.pub, nonce: "n3" },
      store,
    );
    expect(third.ok).toBe(true);
  });
});

describe("funding-address stability", () => {
  it("same key → same funding address across reservation instances", async () => {
    const { pub } = freshKey();
    const norm = normalizeSecp256k1Pubkey(pub);
    const r1 = await reserveHandle({ username: "stableone", claimant_pubkey: pub, nonce: "n1" }, store);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const addr1 = r1.reservation.funding_address;
    // Instance ends (released); a fresh reservation for another handle…
    await deleteReservation("stableone", r1.reservation.reservation_id, store);
    const r2 = await reserveHandle({ username: "stabletwo", claimant_pubkey: pub, nonce: "n2" }, store);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.reservation.funding_address).toBe(addr1);
    // …and it matches the pure derivation.
    expect(addr1).toBe(deriveFundingAddress(norm));
  });
});

describe("renewal", () => {
  it("one renewal extends once; a second renewal is rejected", async () => {
    const { pub } = freshKey();
    const r = await reserveHandle({ username: "renewme", claimant_pubkey: pub, nonce: "n1" }, store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const firstExpiry = r.reservation.expires_at;
    const ren = await reserveHandle(
      { username: "renewme", claimant_pubkey: pub, nonce: "n1", renew: true },
      store,
    );
    expect(ren.ok).toBe(true);
    if (!ren.ok) return;
    expect(ren.renewed).toBe(true);
    expect(ren.reservation.renewals_used).toBe(1);
    expect(ren.reservation.expires_at).toBeGreaterThanOrEqual(firstExpiry);
    const ren2 = await reserveHandle(
      { username: "renewme", claimant_pubkey: pub, nonce: "n1", renew: true },
      store,
    );
    expect(ren2.ok).toBe(false);
    if (!ren2.ok) expect(ren2.error).toMatch(/renewal already used/);
  });

  it("renewal by another key is rejected", async () => {
    const a = freshKey();
    const b = freshKey();
    await reserveHandle({ username: "renewmine", claimant_pubkey: a.pub, nonce: "n1" }, store);
    const r = await reserveHandle(
      { username: "renewmine", claimant_pubkey: b.pub, nonce: "n2", renew: true },
      store,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/another key/);
  });
});

describe("releaseReservation — claimant-signed release", () => {
  it("valid signature releases; tombstone is released-by-claimant with actor", async () => {
    const { pub, priv } = freshKey();
    const r = await reserveHandle({ username: "releaseme", claimant_pubkey: pub, nonce: "n1" }, store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const msg = releaseMessage("releaseme", r.reservation.reservation_id);
    const sig = Buffer.from(priv.sign(Buffer.from(msg, "utf8"))).toString("hex");
    const rel = await releaseReservation("releaseme", sig, store);
    expect(rel).toEqual({ released: true, username: "releaseme" });
    expect(await getReservation("releaseme", store)).toBeNull();
    const tomb = await getTombstone("releaseme", r.reservation.reservation_id, store);
    expect(tomb?.terminal_state).toBe("released-by-claimant");
    expect(tomb?.actor_pubkey).toBe(pub.toLowerCase());
    // The handle is immediately available again.
    const other = freshKey();
    const r2 = await reserveHandle({ username: "releaseme", claimant_pubkey: other.pub, nonce: "n9" }, store);
    expect(r2.ok).toBe(true);
  });

  it("wrong-key signature is rejected; reservation survives", async () => {
    const { pub } = freshKey();
    const evil = freshKey();
    const r = await reserveHandle({ username: "dontsteal", claimant_pubkey: pub, nonce: "n1" }, store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const msg = releaseMessage("dontsteal", r.reservation.reservation_id);
    const badSig = Buffer.from(evil.priv.sign(Buffer.from(msg, "utf8"))).toString("hex");
    const rel = await releaseReservation("dontsteal", badSig, store);
    expect(rel).toEqual(expect.objectContaining({ error: expect.stringMatching(/invalid release signature/) }));
    expect(await getReservation("dontsteal", store)).not.toBeNull();
  });

  it("malformed signature is rejected", async () => {
    const rel = await releaseReservation("whatever", "zzzz", store);
    expect(rel).toEqual(expect.objectContaining({ error: expect.stringMatching(/invalid signature/) }));
  });

  it("release of a non-reserved handle errors cleanly", async () => {
    const { priv } = freshKey();
    const sig = Buffer.from(priv.sign(Buffer.from("x", "utf8"))).toString("hex");
    const rel = await releaseReservation("neverreserved", sig, store);
    expect(rel).toEqual(expect.objectContaining({ error: expect.stringMatching(/no active reservation/) }));
  });
});

describe("tombstones", () => {
  it("expired-by-TTL is written lazily when expiry is observed on read", async () => {
    const { pub } = freshKey();
    const r = await reserveHandle({ username: "willexpire", claimant_pubkey: pub, nonce: "n1" }, store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Simulate backend TTL firing: drop the reservation key directly,
    // leaving the longer-lived index behind.
    await store.del(`claim-reservation:willexpire`);
    expect(await getReservation("willexpire", store)).toBeNull();
    const tomb = await getTombstone("willexpire", r.reservation.reservation_id, store);
    expect(tomb?.terminal_state).toBe("expired-by-TTL");
    expect(tomb?.pubkey_hash).toBe(pubkeyHash(pub.toLowerCase()));
    // A release is an act with an actor; an expiry is an absence — the
    // row types are distinct.
    expect(tomb?.actor_pubkey).toBeUndefined();
  });

  it("completed tombstone round-trips", async () => {
    await writeTombstone(
      {
        reservation_id: "abc123",
        username: "donehandle",
        terminal_state: "completed",
        pubkey_hash: "ph",
        funder: "0.0.1111",
        funding_txid: "0.0.1111@1234.5678",
        created_at: 1,
        ended_at: 2,
      },
      store,
    );
    const tomb = await getTombstone("donehandle", "abc123", store);
    expect(tomb?.terminal_state).toBe("completed");
    expect(tomb?.funder).toBe("0.0.1111");
  });
});

describe("verifyFundingTxid — declared-then-verified", () => {
  const ALIAS = "0x00000000000000000000000000000000000abcde";
  const ALIAS_ACCT = "0.0.9999";
  const TXID = "0.0.1111@1790000000.123456789";

  function fundingFetch(txBody: unknown, aliasBody: unknown = { account: ALIAS_ACCT }) {
    return (async (url: string) => {
      if (url.includes("/accounts/")) return ok(aliasBody);
      if (url.includes("/transactions/")) {
        return txBody === null ? notFound : ok(txBody);
      }
      return notFound;
    }) as unknown as typeof fetch;
  }

  it("accepts a funding tx that pays the alias >= the floor; payer from chain data", async () => {
    const fetchFn = fundingFetch({
      transaction_id: TXID,
      transfers: [
        { account: "0.0.1111", amount: -150_000_000 },
        { account: ALIAS_ACCT, amount: 150_000_000 },
      ],
    });
    const v = await verifyFundingTxid(TXID, ALIAS, fetchFn);
    expect(v).toEqual({ payer: "0.0.1111", fundedTinybar: 150_000_000, aliasAccountId: ALIAS_ACCT });
  });

  it("rejects dust below the floor", async () => {
    const fetchFn = fundingFetch({
      transaction_id: TXID,
      transfers: [{ account: ALIAS_ACCT, amount: 1_000 }],
    });
    const v = await verifyFundingTxid(TXID, ALIAS, fetchFn);
    expect(v).toEqual(expect.objectContaining({ error: expect.stringMatching(/below.*minimum|minimum/i) }));
  });

  it("a dust tx that was never declared is simply not the funding — declared txid rules", async () => {
    // Attacker dusts the alias in THEIR tx; claimant declares their own.
    const attackerTx = "0.0.6666@1790000001.000000001";
    const fetchFn = fundingFetch(
      {
        transaction_id: attackerTx,
        transfers: [{ account: ALIAS_ACCT, amount: 2_000_000_000 }],
      },
      { account: ALIAS_ACCT },
    );
    // The claimant declares the ATTACKER's txid by mistake → the payer
    // reads as the attacker. Declared-then-verified: the chain proves WHO
    // paid the declared tx, so misattribution is visible, not silent.
    const v = await verifyFundingTxid(attackerTx, ALIAS, fetchFn);
    expect(v).toEqual(expect.objectContaining({ payer: "0.0.6666" }));
  });

  it("404 on the transaction → clean error", async () => {
    const v = await verifyFundingTxid(TXID, ALIAS, fundingFetch(null));
    expect(v).toEqual(expect.objectContaining({ error: expect.stringMatching(/not found/) }));
  });

  it("txid/record payer mismatch → rejected", async () => {
    const fetchFn = fundingFetch({
      transaction_id: "0.0.2222@1790000000.123456789",
      transfers: [{ account: ALIAS_ACCT, amount: 200_000_000 }],
    });
    const v = await verifyFundingTxid(TXID, ALIAS, fetchFn);
    expect(v).toEqual(expect.objectContaining({ error: expect.stringMatching(/mismatch/) }));
  });

  it("unfunded alias (no account yet) → clean error", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/accounts/")) return notFound;
      return notFound;
    }) as unknown as typeof fetch;
    const v = await verifyFundingTxid(TXID, ALIAS, fetchFn);
    expect(v).toEqual(expect.objectContaining({ error: expect.stringMatching(/no funding found/) }));
  });

  it("malformed txid → clean error", async () => {
    const v = await verifyFundingTxid("bogus", ALIAS, fundingFetch(null));
    expect(v).toEqual(expect.objectContaining({ error: expect.stringMatching(/invalid funding_txid/) }));
  });
});

describe("checkFunderCap", () => {
  it(`allows ${FUNDER_CAP}, rejects the next — then the message says "funder cap" plainly`, async () => {
    for (let i = 0; i < FUNDER_CAP; i++) {
      const c = await checkFunderCap("0.0.4242", store);
      expect(c).toEqual({ ok: true, used: i + 1 });
    }
    const over = await checkFunderCap("0.0.4242", store);
    expect(over).toEqual(expect.objectContaining({ error: expect.stringMatching(/funder cap/) }));
    if ("error" in (over as object)) {
      expect((over as { error: string }).error).toMatch(/wallet you control/);
    }
  });

  it("caps are per-payer", async () => {
    expect(await checkFunderCap("0.0.1", store)).toEqual({ ok: true, used: 1 });
    expect(await checkFunderCap("0.0.2", store)).toEqual({ ok: true, used: 1 });
  });

  it("rejects bad payer ids", async () => {
    expect(await checkFunderCap("bogus", store)).toEqual(
      expect.objectContaining({ error: expect.any(String) }),
    );
  });
});

describe("constants", () => {
  it("fee floor is 1 HBAR", () => {
    expect(MIN_FUNDING_TINYBAR).toBe(100_000_000);
  });
});

describe("claimFundingTxid — txid replay guard", () => {
  const TX = "0.0.4242@1789520539.844492534";
  const R1 = "res-one-00000000000000000000001";
  const R2 = "res-two-00000000000000000000002";

  it("first declarer wins; a different reservation presenting the same txid is rejected", async () => {
    expect(await claimFundingTxid(TX, R1, store)).toEqual({ ok: true });
    const second = await claimFundingTxid(TX, R2, store);
    expect(second).toEqual(expect.objectContaining({ error: expect.any(String) }));
    if ("error" in (second as object)) {
      expect((second as { error: string }).error).toMatch(/already used for another claim/);
    }
  });

  it("same reservation re-presenting its txid is allowed (idempotent retry)", async () => {
    expect(await claimFundingTxid(TX, R1, store)).toEqual({ ok: true });
    expect(await claimFundingTxid(TX, R1, store)).toEqual({ ok: true });
    expect(await claimFundingTxid(TX, R1, store)).toEqual({ ok: true });
  });

  it("concurrent declarations: exactly one reservation wins", async () => {
    const [a, b] = await Promise.all([
      claimFundingTxid(TX, R1, store),
      claimFundingTxid(TX, R2, store),
    ]);
    const oks = [a, b].filter((r) => "ok" in r);
    const errs = [a, b].filter((r) => "error" in r);
    expect(oks).toHaveLength(1);
    expect(errs).toHaveLength(1);
  });

  it("different txids are independent", async () => {
    expect(await claimFundingTxid("0.0.1@1.000000001", R1, store)).toEqual({ ok: true });
    expect(await claimFundingTxid("0.0.1@1.000000002", R1, store)).toEqual({ ok: true });
    expect(await claimFundingTxid("0.0.1@1.000000001", R2, store)).toEqual(
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it("malformed txid is rejected", async () => {
    const bad = await claimFundingTxid("not-a-txid", R1, store);
    expect(bad).toEqual(expect.objectContaining({ error: expect.stringMatching(/invalid funding_txid/) }));
  });
});
