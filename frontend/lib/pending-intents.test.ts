/**
 * Tests for the pending-intent ledger (lib/pending-intents.ts).
 *
 * The ledger is the durable record of the *question*: every wallet write
 * persists its client-generated tx ID before broadcast, so an interrupted
 * session can re-ask the mirror node instead of losing the handle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  listPendingIntents,
  savePendingIntent,
  removePendingIntent,
  reconcilePendingIntents,
  reconcileAndGate,
  UnresolvedIntentError,
  type PendingIntent,
} from "./pending-intents";

function makeIntent(txId: string): PendingIntent {
  return {
    txId,
    kind: "tipPage",
    label: `Tip to someone (${txId})`,
    account: "0.0.1234",
    createdAt: 1700000000000,
  };
}

beforeEach(() => {
  // In-memory localStorage shim (vitest runs in node here).
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pending-intent ledger", () => {
  it("starts empty and round-trips a saved intent", () => {
    expect(listPendingIntents()).toEqual([]);
    savePendingIntent(makeIntent("0.0.1@1.1"));
    const all = listPendingIntents();
    expect(all).toHaveLength(1);
    expect(all[0].txId).toBe("0.0.1@1.1");
    expect(all[0].label).toContain("Tip to someone");
  });

  it("dedupes by txId — re-saving the same intent does not duplicate", () => {
    savePendingIntent(makeIntent("0.0.1@1.1"));
    savePendingIntent(makeIntent("0.0.1@1.1"));
    expect(listPendingIntents()).toHaveLength(1);
  });

  it("removes an intent by txId", () => {
    savePendingIntent(makeIntent("0.0.1@1.1"));
    savePendingIntent(makeIntent("0.0.1@2.2"));
    removePendingIntent("0.0.1@1.1");
    const all = listPendingIntents();
    expect(all).toHaveLength(1);
    expect(all[0].txId).toBe("0.0.1@2.2");
  });

  it("caps stored intents so the ledger cannot grow unbounded", () => {
    for (let i = 0; i < 30; i++) savePendingIntent(makeIntent(`0.0.1@${i}.${i}`));
    expect(listPendingIntents().length).toBeLessThanOrEqual(20);
  });

  it("ignores corrupt or foreign entries instead of throwing", () => {
    const w = window as unknown as { localStorage: Storage };
    w.localStorage.setItem(
      "vs.pendingIntents.v1",
      JSON.stringify([{ nope: true }, "junk", makeIntent("0.0.1@9.9")]),
    );
    const all = listPendingIntents();
    expect(all).toHaveLength(1);
    expect(all[0].txId).toBe("0.0.1@9.9");
  });

  it("reconcile clears resolved intents and keeps unanswered ones", async () => {
    savePendingIntent(makeIntent("0.0.1@1.1")); // success
    savePendingIntent(makeIntent("0.0.1@2.2")); // failed
    savePendingIntent(makeIntent("0.0.1@3.3")); // unknown — stays
    const summary = await reconcilePendingIntents(async (txId) => {
      if (txId === "0.0.1@1.1") return "success";
      if (txId === "0.0.1@2.2") return "failed";
      return "unknown";
    });
    expect(summary.resolved).toBe(2);
    expect(summary.stillPending).toBe(1);
    expect(listPendingIntents().map((i) => i.txId)).toEqual(["0.0.1@3.3"]);
  });

  it("reconcile treats a checker exception as unknown — the intent is kept, never dropped", async () => {
    savePendingIntent(makeIntent("0.0.1@7.7"));
    const summary = await reconcilePendingIntents(async () => {
      throw new Error("mirror node unreachable");
    });
    expect(summary.resolved).toBe(0);
    expect(summary.stillPending).toBe(1);
  });

  it("reconcile clears an expired intent — the mirror indexed past its window without seeing it", async () => {
    savePendingIntent(makeIntent("0.0.1@8.8")); // expired — cleared
    savePendingIntent(makeIntent("0.0.1@9.9")); // unknown — stays
    const summary = await reconcilePendingIntents(async (txId) =>
      txId === "0.0.1@8.8" ? "expired" : "unknown",
    );
    expect(summary.resolved).toBe(1);
    expect(summary.stillPending).toBe(1);
    expect(listPendingIntents().map((i) => i.txId)).toEqual(["0.0.1@9.9"]);
  });
});

describe("pending-intent ledger without a browser", () => {
  it("degrades to a no-op outside the browser and never throws", async () => {
    vi.unstubAllGlobals(); // no window at all
    expect(listPendingIntents()).toEqual([]);
    expect(() => savePendingIntent(makeIntent("0.0.1@1.1"))).not.toThrow();
    expect(() => removePendingIntent("0.0.1@1.1")).not.toThrow();
    const summary = await reconcilePendingIntents(async () => "success");
    expect(summary).toEqual({ resolved: 0, stillPending: 0 });
  });
});

describe("reconcileAndGate — unknown is never permission to retry", () => {
  it("passes silently when the ledger is empty", async () => {
    await expect(
      reconcileAndGate(async () => "success", "0.0.1234"),
    ).resolves.toBeUndefined();
  });

  it("passes when the only intent reaches a definitive outcome", async () => {
    savePendingIntent(makeIntent("0.0.1@1.1"));
    await expect(
      reconcileAndGate(async () => "success", "0.0.1234"),
    ).resolves.toBeUndefined();
    expect(listPendingIntents()).toEqual([]);
  });

  it("blocks the write while an intent is still unknown — and keeps the intent stored", async () => {
    savePendingIntent(makeIntent("0.0.1@3.3"));
    const err = await reconcileAndGate(async () => "unknown", "0.0.1234").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(UnresolvedIntentError);
    expect(err.intents.map((i: PendingIntent) => i.txId)).toEqual(["0.0.1@3.3"]);
    expect(err.message).toContain("0.0.1@3.3");
    // The question is preserved, not dropped — the next session re-asks.
    expect(listPendingIntents().map((i) => i.txId)).toEqual(["0.0.1@3.3"]);
  });

  it("clears resolvable intents first, then still blocks on the remaining unknown one", async () => {
    savePendingIntent(makeIntent("0.0.1@1.1")); // success — cleared
    savePendingIntent(makeIntent("0.0.1@3.3")); // unknown — blocks
    const err = await reconcileAndGate(
      async (txId) => (txId === "0.0.1@1.1" ? "success" : "unknown"),
      "0.0.1234",
    ).catch((e) => e);
    expect(err).toBeInstanceOf(UnresolvedIntentError);
    expect(err.intents.map((i: PendingIntent) => i.txId)).toEqual(["0.0.1@3.3"]);
    expect(listPendingIntents().map((i) => i.txId)).toEqual(["0.0.1@3.3"]);
  });

  it("a checker exception degrades to unknown — the write is blocked, not released", async () => {
    savePendingIntent(makeIntent("0.0.1@7.7"));
    const err = await reconcileAndGate(async () => {
      throw new Error("mirror node unreachable");
    }, "0.0.1234").catch((e) => e);
    expect(err).toBeInstanceOf(UnresolvedIntentError);
  });

  it("does not block on another account's unresolved intent", async () => {
    const other: PendingIntent = { ...makeIntent("0.0.1@9.9"), account: "0.0.9999" };
    savePendingIntent(other);
    await expect(
      reconcileAndGate(async () => "unknown", "0.0.1234"),
    ).resolves.toBeUndefined();
    // The other account's question is untouched.
    expect(listPendingIntents().map((i) => i.txId)).toEqual(["0.0.1@9.9"]);
  });
});
