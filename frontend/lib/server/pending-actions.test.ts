/**
 * Tests for the pending-actions inbox (lib/server/pending-actions.ts).
 * All persistence is a fake in-memory KvStore — no network, no real store.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { KvStore } from "./store";
import {
  stashPendingAction,
  getPendingAction,
  clearPendingAction,
} from "./pending-actions";

class FakeStore implements KvStore {
  private data = new Map<string, string>();
  async incr(): Promise<number> {
    throw new Error("unused");
  }
  async setNx(): Promise<boolean> {
    throw new Error("unused");
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  async clearPrefix(prefix: string): Promise<void> {
    for (const k of [...this.data.keys()]) {
      if (k.startsWith(prefix)) this.data.delete(k);
    }
  }
}

const PKG = {
  username: "thechomps",
  owner_account_id: "0.0.10424063",
  operator: "0x0000000000000000000000000000000000000001",
  purpose: "test agent",
  cid: "bafytest",
  page_url: "https://example.com/user-10425049",
  unsignedTxBytes: "dGVzdA==",
  what_youre_signing: "Register @thechomps as your agent's blockpage.",
  transactionId: "0.0.10424063@1700000000.000000001",
  txType: "registerPage",
  next: "test",
};

describe("pending-actions inbox", () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it("stashes and retrieves the owner's pending action", async () => {
    const stashed = await stashPendingAction(PKG, store);
    expect(stashed.kind).toBe("agent-claim");
    expect(stashed.title).toBe("Register @thechomps");
    expect(stashed.payload.signerAccountId).toBe("hedera:mainnet:0.0.10424063");
    expect(stashed.payload.transactionList).toBe("dGVzdA==");

    const got = await getPendingAction("0.0.10424063", store);
    expect(got?.id).toBe(stashed.id);
    expect(got?.summary).toBe(PKG.what_youre_signing);
  });

  it("returns null when the inbox is empty", async () => {
    expect(await getPendingAction("0.0.1", store)).toBeNull();
  });

  it("replaces the previous action for the same owner", async () => {
    const first = await stashPendingAction(PKG, store);
    const second = await stashPendingAction({ ...PKG, username: "other" }, store);
    expect(second.id).not.toBe(first.id);
    const got = await getPendingAction("0.0.10424063", store);
    expect(got?.id).toBe(second.id);
    expect(got?.title).toBe("Register @other");
  });

  it("clear removes the slot", async () => {
    await stashPendingAction(PKG, store);
    await clearPendingAction("0.0.10424063", store);
    expect(await getPendingAction("0.0.10424063", store)).toBeNull();
  });

  it("scopes slots per owner", async () => {
    await stashPendingAction(PKG, store);
    expect(await getPendingAction("0.0.99999999", store)).toBeNull();
  });

  it("rejects packages that aren't claim packages", async () => {
    await expect(stashPendingAction({ nope: true }, store)).rejects.toThrow();
    await expect(stashPendingAction(null, store)).rejects.toThrow();
  });
});
