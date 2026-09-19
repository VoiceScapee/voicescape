/** Vote/listings aggregation tests — pure logic, no network. */
import { describe, expect, it } from "vitest";
import {
  aggregateListings,
  aggregateRepVotes,
  countProposalVotes,
  orderNewestFirst,
} from "./votes";
import type { StoredMessage } from "./types";

function msg(contents: object, seq: number): StoredMessage {
  const c = contents as { author?: unknown };
  const m: StoredMessage = {
    seq,
    topic: "0.0.1",
    consensusTimestamp: "2026-09-10T00:00:00Z",
    contents: contents as StoredMessage["contents"],
  };
  // Test messages simulate the API write path, which attests authorship.
  if (typeof c.author === "string") {
    m.attestation = { payer: "0.0.0", author: c.author };
  }
  return m;
}

/** A message that bypassed the API write path (direct-to-topic forgery): no attestation. */
function msgUnattested(contents: object, seq: number): StoredMessage {
  return {
    seq,
    topic: "0.0.1",
    consensusTimestamp: "2026-09-10T00:00:00Z",
    contents: contents as StoredMessage["contents"],
  };
}

const repVote = (voter: string, target: string, value: 1 | -1) =>
  msg({ v: 1, kind: "rep-vote", ts: "2026-09-10T00:00:00Z", author: voter, target, voter, value }, 0);

describe("aggregateRepVotes", () => {
  it("counts up/down and computes score", () => {
    const messages = [
      repVote("alice", "bob", 1),
      repVote("carol", "bob", 1),
      repVote("dave", "bob", -1),
    ];
    const t = aggregateRepVotes(messages, "bob");
    expect(t).toEqual({ up: 2, down: 1, score: 1, myVote: null });
  });

  it("latest vote per (voter, target) wins — votes are changeable", () => {
    const messages = [repVote("alice", "bob", 1), repVote("alice", "bob", -1)];
    const t = aggregateRepVotes(messages, "bob");
    expect(t).toEqual({ up: 0, down: 1, score: -1, myVote: null });
  });

  it("ignores self-votes at aggregation time", () => {
    const messages = [repVote("bob", "bob", 1), repVote("alice", "bob", 1)];
    const t = aggregateRepVotes(messages, "bob");
    expect(t.up).toBe(1);
    expect(t.score).toBe(1);
  });

  it("ignores votes for other targets and invalid values", () => {
    const messages = [
      repVote("alice", "carol", 1),
      msg(
        { v: 1, kind: "rep-vote", ts: "2026-09-10T00:00:00Z", author: "alice", target: "bob", voter: "alice", value: 5 },
        0,
      ),
    ];
    const t = aggregateRepVotes(messages, "bob");
    expect(t).toEqual({ up: 0, down: 0, score: 0, myVote: null });
  });

  it("returns the requesting voter's current vote as myVote", () => {
    const messages = [repVote("alice", "bob", 1), repVote("carol", "bob", -1)];
    expect(aggregateRepVotes(messages, "bob", "alice").myVote).toBe(1);
    expect(aggregateRepVotes(messages, "bob", "carol").myVote).toBe(-1);
    expect(aggregateRepVotes(messages, "bob", "dave").myVote).toBe(null);
  });
});

describe("countProposalVotes", () => {
  const pv = (voter: string, proposal: string, choice: string) =>
    msg({ v: 1, kind: "proposal-vote", ts: "2026-09-10T00:00:00Z", author: voter, proposal, voter, choice }, 0);

  it("counts yes/no/abstain", () => {
    const messages = [
      pv("alice", "p1", "yes"),
      pv("bob", "p1", "no"),
      pv("carol", "p1", "abstain"),
      pv("dave", "p1", "yes"),
    ];
    expect(countProposalVotes(messages, "p1")).toEqual({ yes: 2, no: 1, abstain: 1 });
  });

  it("latest vote per (voter, proposal) wins", () => {
    const messages = [pv("alice", "p1", "yes"), pv("alice", "p1", "no"), pv("bob", "p1", "yes")];
    expect(countProposalVotes(messages, "p1")).toEqual({ yes: 1, no: 1, abstain: 0 });
  });

  it("ignores votes for other proposals and invalid choices", () => {
    const messages = [pv("alice", "p2", "yes"), pv("bob", "p1", "maybe")];
    expect(countProposalVotes(messages, "p1")).toEqual({ yes: 0, no: 0, abstain: 0 });
  });
});

describe("orderNewestFirst", () => {
  it("orders chat/post views by descending sequence number", () => {
    const items = [{ seq: 3 }, { seq: 1 }, { seq: 2 }];
    expect(orderNewestFirst(items).map((i) => i.seq)).toEqual([3, 2, 1]);
  });
});

describe("aggregateListings", () => {
  const listing = (id: string, status: "active" | "sold" | "cancelled") =>
    msg(
      {
        v: 1,
        kind: "listing",
        ts: "2026-09-10T00:00:00Z",
        author: "alice",
        id,
        seller: "alice",
        title: "T",
        description: "D",
        priceUsdCents: 100,
        goodsType: "digital",
        ipfsHash: null,
        status,
      },
      0,
    );

  it("latest message per id wins — status updates replace the view", () => {
    const messages = [listing("l1", "active"), listing("l2", "active"), listing("l1", "sold")];
    const latest = aggregateListings(messages);
    expect(latest.size).toBe(2);
    expect(latest.get("l1")!.contents.status).toBe("sold");
    expect(latest.get("l2")!.contents.status).toBe("active");
  });
});

describe("attestation filtering (audit fix #1)", () => {
  it("skips unattested rep-votes (direct-to-topic forgeries)", () => {
    const messages = [
      repVote("alice", "bob", 1),
      msgUnattested(
        { v: 1, kind: "rep-vote", ts: "2026-09-10T00:00:00Z", author: "mallory", target: "bob", voter: "mallory", value: 1 },
        0,
      ),
    ];
    const t = aggregateRepVotes(messages, "bob");
    expect(t).toEqual({ up: 1, down: 0, score: 1, myVote: null });
  });

  it("skips votes where the attestation author differs from the claimed voter", () => {
    const forged = msg(
      { v: 1, kind: "rep-vote", ts: "2026-09-10T00:00:00Z", author: "mallory", target: "bob", voter: "alice", value: -1 },
      0,
    );
    // Attestation binds the bytes to mallory (the real submitter), not alice (the claimed voter).
    forged.attestation = { payer: "0.0.999", author: "mallory" };
    const messages = [repVote("alice", "bob", 1), forged];
    const t = aggregateRepVotes(messages, "bob");
    expect(t).toEqual({ up: 1, down: 0, score: 1, myVote: null });
  });

  it("skips unattested proposal votes", () => {
    const pv = (voter: string, proposal: string, choice: string) =>
      msg({ v: 1, kind: "proposal-vote", ts: "2026-09-10T00:00:00Z", author: voter, proposal, voter, choice }, 0);
    const forged = msgUnattested(
      { v: 1, kind: "proposal-vote", ts: "2026-09-10T00:00:00Z", author: "mallory", proposal: "p1", voter: "mallory", choice: "no" },
      0,
    );
    expect(countProposalVotes([pv("alice", "p1", "yes"), forged], "p1")).toEqual({ yes: 1, no: 0, abstain: 0 });
  });

  it("myVote only reflects attested votes", () => {
    const unattested = msgUnattested(
      { v: 1, kind: "rep-vote", ts: "2026-09-10T00:00:00Z", author: "dave", target: "bob", voter: "dave", value: -1 },
      0,
    );
    expect(aggregateRepVotes([unattested], "bob", "dave").myVote).toBe(null);
  });
});
