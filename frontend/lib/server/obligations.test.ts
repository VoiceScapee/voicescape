/**
 * Tests for the obligation lifecycle core (lib/server/obligations.ts).
 * Mirror node and KV are fakes — no network, no real store.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { KvStore } from "./store";
import { attestObligation, getObligation } from "./obligations";

class FakeStore implements KvStore {
  private data = new Map<string, { value: string; expiresAt: number }>();
  private alive(key: string): boolean {
    const e = this.data.get(key);
    if (!e) return false;
    if (e.expiresAt <= Date.now()) {
      this.data.delete(key);
      return false;
    }
    return true;
  }
  async incr(key: string, ttlMs: number): Promise<number> {
    const cur = this.alive(key) ? Number(this.data.get(key)!.value) : 0;
    const next = cur + 1;
    this.data.set(key, { value: String(next), expiresAt: Date.now() + ttlMs });
    return next;
  }
  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.alive(key)) return false;
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
    return true;
  }
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
  async get(key: string): Promise<string | null> {
    return this.alive(key) ? this.data.get(key)!.value : null;
  }
  async del(key: string): Promise<void> {
    this.data.delete(key);
  }
  async clearPrefix(prefix: string): Promise<void> {
    for (const k of [...this.data.keys()]) if (k.startsWith(prefix)) this.data.delete(k);
  }
}

const PAYER = "0.0.1111";
const PAYEE = "0.0.2222";
const TX = "0.0.9999-1700000000-123456789";

interface FakeMirrorTx {
  transaction_id: string;
  result: string;
  consensus_timestamp: string;
  transfers: Array<{ account: string; amount: number }>;
  token_transfers: Array<{ token_id: string; account: string; amount: number }>;
}

function mirrorTx(result = "SUCCESS", transfers?: FakeMirrorTx["transfers"]): { ok: true; json: () => Promise<{ transactions: FakeMirrorTx[] }> } {
  const t =
    transfers ??
    [
      { account: PAYER, amount: -1_000_000 },
      { account: PAYEE, amount: 1_000_000 },
      { account: "0.0.98", amount: 10 },
      { account: "0.0.3", amount: 5 },
    ];
  return {
    ok: true,
    json: async () => ({
      transactions: [
        {
          transaction_id: TX,
          result,
          consensus_timestamp: "1700000000.123456789",
          transfers: t,
          token_transfers: [],
        },
      ],
    }),
  };
}

function fakeFetch(txResult: ReturnType<typeof mirrorTx> | { status: number }) {
  return (async (_url: string) => {
    if ("status" in txResult) return { ok: false, status: txResult.status, json: async () => ({}) };
    return { status: 200, ...txResult };
  }) as unknown as typeof fetch;
}

describe("attestObligation", () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  const deps = (txResult: ReturnType<typeof mirrorTx>) => ({
    store,
    fetchImpl: fakeFetch(txResult),
    nowMs: 1_700_000_000_000,
  });

  it("creates a settled record and moves it to fulfilled on payee attestation", async () => {
    const r = await attestObligation(
      { paymentTxId: TX, state: "fulfilled", wallet: PAYEE, note: "delivered" },
      deps(mirrorTx()),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.state).toBe("fulfilled");
    expect(r.record.payer).toBe(PAYER);
    expect(r.record.payee).toBe(PAYEE);
    expect(r.record.attestations).toHaveLength(1);
    expect(r.record.attestations[0].note).toBe("delivered");
    expect(r.record.hashscan).toContain(TX);
  });

  it("refuses a pending (404) transaction — never attests vapor", async () => {
    const r = await attestObligation(
      { paymentTxId: TX, state: "fulfilled", wallet: PAYEE },
      { store, fetchImpl: fakeFetch({ status: 404 }), nowMs: 1_700_000_000_000 },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("payment-not-found");
  });

  it("refuses a non-SUCCESS transaction", async () => {
    const r = await attestObligation(
      { paymentTxId: TX, state: "fulfilled", wallet: PAYEE },
      deps(mirrorTx("CONTRACT_REVERT_EXECUTED")),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("payment-not-successful");
  });

  it("rejects the wrong side: payer cannot attest fulfilled", async () => {
    const r = await attestObligation(
      { paymentTxId: TX, state: "fulfilled", wallet: PAYER },
      deps(mirrorTx()),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("not-a-counterparty");
    expect(r.detail).toContain("payee");
  });

  it("lets the payer dispute, then the payee resolve to refunded", async () => {
    const d = deps(mirrorTx());
    const dispute = await attestObligation({ paymentTxId: TX, state: "disputed", wallet: PAYER }, d);
    expect(dispute.ok).toBe(true);
    if (!dispute.ok) return;
    expect(dispute.record.state).toBe("disputed");

    const refund = await attestObligation({ paymentTxId: TX, state: "refunded", wallet: PAYEE }, d);
    expect(refund.ok).toBe(true);
    if (!refund.ok) return;
    expect(refund.record.state).toBe("refunded");
    expect(refund.record.attestations).toHaveLength(2);
  });

  it("treats terminal states as terminal: no re-attestation of fulfilled", async () => {
    const d = deps(mirrorTx());
    await attestObligation({ paymentTxId: TX, state: "fulfilled", wallet: PAYEE }, d);
    const again = await attestObligation({ paymentTxId: TX, state: "fulfilled", wallet: PAYEE }, d);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error).toBe("terminal-state");
  });

  it("rejects illegal transitions: settled cannot go straight to refunded", async () => {
    const d = deps(mirrorTx());
    // First attestation creates the record at settled, then tries refunded.
    const r = await attestObligation({ paymentTxId: TX, state: "refunded", wallet: PAYEE }, d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("terminal-state");
  });

  it("rejects malformed transaction ids", async () => {
    const r = await attestObligation(
      { paymentTxId: "not-a-tx", state: "fulfilled", wallet: PAYEE },
      deps(mirrorTx()),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("bad-tx-id");
  });

  it("refuses ambiguous multi-token payments instead of guessing", async () => {
    const multi: { ok: true; json: () => Promise<{ transactions: FakeMirrorTx[] }> } = {
      ok: true,
      json: async () => ({
        transactions: [
          {
            transaction_id: TX,
            result: "SUCCESS",
            consensus_timestamp: "1700000000.1",
            transfers: [],
            token_transfers: [
              { token_id: "0.0.1", account: PAYEE, amount: 100 },
              { token_id: "0.0.2", account: PAYEE, amount: 200 },
            ],
          },
        ],
      }),
    };
    const r = await attestObligation(
      { paymentTxId: TX, state: "fulfilled", wallet: PAYEE },
      { store, fetchImpl: fakeFetch(multi), nowMs: 1_700_000_000_000 },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("ambiguous-payment");
  });
});

describe("getObligation", () => {
  it("returns null when no record exists — absence is not evidence", async () => {
    const store = new FakeStore();
    expect(await getObligation(TX, store)).toBeNull();
  });

  it("reads back a stored record", async () => {
    const store = new FakeStore();
    const d = { store, fetchImpl: fakeFetch(mirrorTx()), nowMs: 1_700_000_000_000 };
    await attestObligation({ paymentTxId: TX, state: "disputed", wallet: PAYER }, d);
    const rec = await getObligation(TX, store);
    expect(rec?.state).toBe("disputed");
    expect(rec?.payer).toBe(PAYER);
  });
});
