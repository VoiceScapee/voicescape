/**
 * Tests for the pending-actions inbox (lib/server/pending-actions.ts).
 * All persistence is a fake in-memory KvStore — no network, no real store.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { KvStore } from "./store";
import {
  stashPendingAction,
  stashPageUpdateProposal,
  getPendingActionById,
  getPendingActionByPublicId,
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

describe("pending-actions page-update proposals", () => {
  let store: KvStore;
  beforeEach(() => { store = fakeStore(); });

  const UPDATE_INPUT = {
    owner_account_id: "0.0.10425049",
    spec: {
      username: "thechomps",
      ownerType: "agent" as const,
      displayName: "The Chomps",
      purpose: "Demo agent page",
      capabilities: ["demo"],
      operator: "0x0000000000000000000000000000000000000000",
      templateId: null,
      theme: null,
      socials: null,
      links: null,
    },
    change_summary: "Updated the bio text",
    token_id: "a".repeat(16),
  };

  it("stashes an update proposal with kind agent-page-update", async () => {
    const action = await stashPageUpdateProposal(UPDATE_INPUT, store);
    expect(action.kind).toBe("agent-page-update");
    expect(action.title).toBe("Update @thechomps");
    expect(action.summary).toBe("Updated the bio text");
    expect(action.claimPackageId).toBeUndefined();
    expect(action.pageUpdate?.spec.username).toBe("thechomps");
    expect(action.pageUpdate?.tokenId).toBe("a".repeat(16));
    const list = await getPendingActions("0.0.10425049", store);
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe("agent-page-update");
  });

  it("mixes claim and update proposals in one inbox under the same cap", async () => {
    await stashPendingAction(INPUT, store);
    await stashPageUpdateProposal(UPDATE_INPUT, store);
    const list = await getPendingActions("0.0.10425049", store);
    expect(list.map((p) => p.kind)).toEqual(["agent-claim", "agent-page-update"]);
  });

  it("finds a single proposal by id", async () => {
    const action = await stashPageUpdateProposal(UPDATE_INPUT, store);
    const found = await getPendingActionById("0.0.10425049", action.id, store);
    expect(found?.id).toBe(action.id);
    expect(await getPendingActionById("0.0.10425049", "deadbeefdeadbeef", store)).toBeNull();
    expect(await getPendingActionById("0.0.99999999", action.id, store)).toBeNull();
  });

  it("rejects invalid update input instead of stashing garbage", async () => {
    await expect(stashPageUpdateProposal({ ...UPDATE_INPUT, owner_account_id: "nope" }, store)).rejects.toThrow();
    await expect(stashPageUpdateProposal({ ...UPDATE_INPUT, spec: { ...UPDATE_INPUT.spec, username: "BAD NAME!" } }, store)).rejects.toThrow();
    await expect(stashPageUpdateProposal({ ...UPDATE_INPUT, change_summary: "" }, store)).rejects.toThrow();
    await expect(stashPageUpdateProposal({ ...UPDATE_INPUT, token_id: "short" }, store)).rejects.toThrow();
  });

  it("counts updates toward the inbox cap — never silently overwrites", async () => {
    await stashPageUpdateProposal(UPDATE_INPUT, store);
    await stashPageUpdateProposal({ ...UPDATE_INPUT, change_summary: "second" }, store);
    await stashPageUpdateProposal({ ...UPDATE_INPUT, change_summary: "third" }, store);
    await expect(stashPageUpdateProposal({ ...UPDATE_INPUT, change_summary: "fourth" }, store)).rejects.toBeInstanceOf(
      PendingActionConflictError,
    );
  });

  it("finds a proposal by its public approval-link id", async () => {
    const action = await stashPageUpdateProposal(UPDATE_INPUT, store);
    const found = await getPendingActionByPublicId(action.id, store);
    expect(found).not.toBeNull();
    expect(found!.ownerAccountId).toBe("0.0.10425049");
    expect(found!.pageUpdate!.changeSummary).toBe("Updated the bio text");
  });

  it("returns null for malformed or unknown public ids", async () => {
    await stashPageUpdateProposal(UPDATE_INPUT, store);
    expect(await getPendingActionByPublicId("not-hex", store)).toBeNull();
    expect(await getPendingActionByPublicId("deadbeefdeadbeef", store)).toBeNull();
    expect(await getPendingActionByPublicId("", store)).toBeNull();
  });

  it("clearing a proposal removes its public lookup", async () => {
    const action = await stashPageUpdateProposal(UPDATE_INPUT, store);
    expect(await getPendingActionByPublicId(action.id, store)).not.toBeNull();
    await clearPendingAction("0.0.10425049", action.id, store);
    expect(await getPendingActionByPublicId(action.id, store)).toBeNull();
  });
});

describe("pending-actions purchase proposals", () => {
  let store: KvStore;
  beforeEach(() => { store = fakeStore(); });

  const PURCHASE = {
    listingId: "badge-1",
    title: "Bacon Badge",
    seller: "creator-bob",
    sellerEvm: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    contractId: "0.0.10854060",
    priceUsdCents: 100,
    valueTinybar: "500000000",
    valueHbar: "5.00000000",
  };

  it("stashes and reads back a purchase proposal with its payload", async () => {
    const { stashPurchaseProposal } = await import("./pending-actions");
    const action = await stashPurchaseProposal(
      { owner_account_id: "0.0.10425049", purchase: PURCHASE, token_id: "a1b2c3d4e5f60718" },
      store,
    );
    expect(action.kind).toBe("purchase");
    expect(action.purchase?.listingId).toBe("badge-1");

    // The new kind survives the readList filter and the public-id lookup.
    const listed = await getPendingActions("0.0.10425049", store);
    expect(listed).toHaveLength(1);
    expect(listed[0].kind).toBe("purchase");
    const byId = await getPendingActionByPublicId(action.id, store);
    expect(byId?.purchase?.valueHbar).toBe("5.00000000");
  });

  it("rejects bad input and a full inbox", async () => {
    const { stashPurchaseProposal } = await import("./pending-actions");
    await expect(
      stashPurchaseProposal(
        { owner_account_id: "0.0.10425049", purchase: { ...PURCHASE, sellerEvm: "nope" }, token_id: "a1b2c3d4e5f60718" },
        store,
      ),
    ).rejects.toThrow(/bad seller EVM/);
    for (let i = 0; i < MAX_PENDING_PER_OWNER; i++) {
      await stashPurchaseProposal(
        { owner_account_id: "0.0.10425049", purchase: PURCHASE, token_id: "a1b2c3d4e5f60718" },
        store,
      );
    }
    await expect(
      stashPurchaseProposal(
        { owner_account_id: "0.0.10425049", purchase: PURCHASE, token_id: "a1b2c3d4e5f60718" },
        store,
      ),
    ).rejects.toBeInstanceOf(PendingActionConflictError);
  });
});

describe("pending-actions hire-review proposals", () => {
  let store: KvStore;
  beforeEach(() => { store = fakeStore(); });

  const REVIEW = {
    reviewerUsername: "reviewer-agent",
    reviewerEvm: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    targetUsername: "target-agent",
    targetEvm: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    rating: 5,
    text: "Fast delivery.",
    proofTxId: "0.0.7@1700000000.000000000",
    proofKind: "purchase" as const,
  };

  it("stashes and reads back a review proposal with its payload", async () => {
    const { stashReviewProposal } = await import("./pending-actions");
    const action = await stashReviewProposal(
      { owner_account_id: "0.0.10425049", review: REVIEW, token_id: "a1b2c3d4e5f60718" },
      store,
    );
    expect(action.kind).toBe("hire-review");
    expect(action.hireReview?.targetUsername).toBe("target-agent");

    const listed = await getPendingActions("0.0.10425049", store);
    expect(listed).toHaveLength(1);
    const byId = await getPendingActionByPublicId(action.id, store);
    expect(byId?.hireReview?.proofTxId).toBe("0.0.7@1700000000.000000000");
  });

  it("rejects self-reviews, bad ratings, and bad proof kinds", async () => {
    const { stashReviewProposal } = await import("./pending-actions");
    await expect(
      stashReviewProposal(
        { owner_account_id: "0.0.10425049", review: { ...REVIEW, targetUsername: "reviewer-agent" }, token_id: "a1b2c3d4e5f60718" },
        store,
      ),
    ).rejects.toThrow(/own page/);
    await expect(
      stashReviewProposal(
        { owner_account_id: "0.0.10425049", review: { ...REVIEW, rating: 6 }, token_id: "a1b2c3d4e5f60718" },
        store,
      ),
    ).rejects.toThrow(/rating must be 1-5/);
    await expect(
      stashReviewProposal(
        {
          owner_account_id: "0.0.10425049",
          review: { ...REVIEW, proofKind: "airdrop" as unknown as "tip" },
          token_id: "a1b2c3d4e5f60718",
        },
        store,
      ),
    ).rejects.toThrow(/bad proof kind/);
  });
});
