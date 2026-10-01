/**
 * Tests for the pending-actions inbox (lib/server/pending-actions.ts).
 * All persistence is a fake in-memory KvStore — no network, no real store.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { KvStore } from "./store";
import {
  stashPendingAction,
  getPendingActions,
  clearPendingAction,
  PendingActionConflictError,
  MAX_PENDING_PER_OWNER,
} from "./pending-actions";

function fakeStore(): KvStore {
  const map = new Map<string, string>();
  return {
    async get(k: string) { return map.get(k) ?? null; },
    async set(k: string, v: string) { map.set(k, v); },
    async del(k: string) { map.delete(k); },
    async incr() { return 1; },
    async setNx(k: string, v: string) { if (map.has(k)) return false; map.set(k, v); return true; },
    async clearPrefix(prefix: string) { for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k); },
  };
}

const ID = "a".repeat(32);
const INPUT = {
  claimPackageId: ID,
  username: "thechomps",
  owner_account_id: "0.0.10425049",
  what_youre_signing: 'registerPage("thechomps") — costs gas only.',
};

describe("pending-actions inbox", () => {
  let store: KvStore;
  beforeEach(() => { store = fakeStore(); });

  it("returns an empty list when nothing is pending", async () => {
    expect(await getPendingActions("0.0.10425049", store)).toEqual([]);
  });

  it("stashes a proposal and reads it back as a one-element list", async () => {
    const action = await stashPendingAction(INPUT, store);
    expect(action.id).toMatch(/^[0-9a-f]{16}$/);
    expect(action.kind).toBe("agent-claim");
    expect(action.ownerAccountId).toBe("0.0.10425049");
    expect(action.claimPackageId).toBe(ID);
    expect(action.title).toBe("Register @thechomps");
    expect(action.summary).toBe(INPUT.what_youre_signing);
    const list = await getPendingActions("0.0.10425049", store);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(action.id);
  });

  it("isolates inboxes per owner", async () => {
    await stashPendingAction(INPUT, store);
    expect(await getPendingActions("0.0.99999999", store)).toEqual([]);
  });

  it("appends proposals in order, oldest first", async () => {
    await stashPendingAction(INPUT, store);
    await stashPendingAction({ ...INPUT, username: "secondagent", claimPackageId: "b".repeat(32) }, store);
    const list = await getPendingActions("0.0.10425049", store);
    expect(list.map((p) => p.title)).toEqual(["Register @thechomps", "Register @secondagent"]);
  });

  it("throws PendingActionConflictError when the inbox is full — never silently overwrites", async () => {
    for (let i = 0; i < MAX_PENDING_PER_OWNER; i++) {
      await stashPendingAction(
        { ...INPUT, username: `agent${i}`, claimPackageId: i.toString(16).padStart(32, "0") },
        store,
      );
    }
    await expect(stashPendingAction({ ...INPUT, username: "one-more" }, store)).rejects.toBeInstanceOf(
      PendingActionConflictError,
    );
    // The originals are all still there.
    expect(await getPendingActions("0.0.10425049", store)).toHaveLength(MAX_PENDING_PER_OWNER);
  });

  it("clears a single proposal by id", async () => {
    const first = await stashPendingAction(INPUT, store);
    await stashPendingAction({ ...INPUT, username: "secondagent", claimPackageId: "b".repeat(32) }, store);
    await clearPendingAction("0.0.10425049", first.id, store);
    const list = await getPendingActions("0.0.10425049", store);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Register @secondagent");
  });

  it("clears the whole inbox when id is omitted", async () => {
    await stashPendingAction(INPUT, store);
    await clearPendingAction("0.0.10425049", undefined, store);
    expect(await getPendingActions("0.0.10425049", store)).toEqual([]);
  });

  it("rejects invalid input instead of stashing garbage", async () => {
    await expect(stashPendingAction({ ...INPUT, owner_account_id: "nope" }, store)).rejects.toThrow();
    await expect(stashPendingAction({ ...INPUT, claimPackageId: "nope" }, store)).rejects.toThrow();
    await expect(stashPendingAction({ ...INPUT, username: "" }, store)).rejects.toThrow();
    await expect(stashPendingAction({ ...INPUT, what_youre_signing: "" }, store)).rejects.toThrow();
  });

  it("ignores corrupt stored data instead of crashing", async () => {
    await store.set("pending-actions:0.0.10425049", "{not json", 1000);
    expect(await getPendingActions("0.0.10425049", store)).toEqual([]);
  });
});
