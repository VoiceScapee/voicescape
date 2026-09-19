/**
 * Authorship attestation tests (audit fix #1).
 *
 * Covers: hashing, the kv-backed record/get roundtrip, the write path
 * (verifyUserHcsTx records the attestation), and the read path
 * (MemoryHcsClient enriches attested messages, leaves others unset).
 * No network, no chain.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryHcsClient } from "./hcs";
import { verifyUserHcsTx, type TownhallDeps } from "./handlers";
import {
  clearAttestations,
  getAttestation,
  getAttestations,
  hashMessageContent,
  isAttestedVote,
  isAuthorVerified,
  recordAttestation,
} from "./attestations";
import { clearConsumedHcsTxIds, type MirrorPort } from "./mirror";
import type { VerifiedSession } from "./auth";

beforeEach(async () => {
  await clearAttestations();
  await clearConsumedHcsTxIds();
});

const TOPIC = "0.0.7003";
const PAYER = "0.0.123";
const TXID = "0.0.123@1694000000.000000001";

function writeDeps(hcs: MemoryHcsClient): TownhallDeps {
  const mirror: MirrorPort = {
    verifyDustFee: async () => ({ ok: true, reason: "ok", receivedTinybars: 1000 }),
    feeInfo: () => ({ dustFeeTinybars: 1000, treasury: "0.0.999" }),
    resolveAccountId: async (address: string) => (address === PAYER ? PAYER : null),
  };
  return { hcs, mirror } as unknown as TownhallDeps;
}

const session: VerifiedSession = {
  address: PAYER,
  chainId: 295,
  nonce: "test",
  expiresAtMs: Date.now() + 3600_000,
};

describe("hashMessageContent", () => {
  it("is stable for the same input", () => {
    expect(hashMessageContent("hello")).toBe(hashMessageContent("hello"));
  });

  it("differs for different inputs", () => {
    expect(hashMessageContent("hello")).not.toBe(hashMessageContent("hello "));
  });

  it("returns 64 hex chars (sha256)", () => {
    expect(hashMessageContent("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("record/get roundtrip", () => {
  it("records and retrieves an attestation", async () => {
    const hash = hashMessageContent("some-bytes");
    await recordAttestation(hash, { payer: PAYER, author: "alice", topic: TOPIC, txId: TXID });
    const att = await getAttestation(hash);
    expect(att).toMatchObject({ payer: PAYER, author: "alice", topic: TOPIC, txId: TXID });
    expect(typeof att!.at).toBe("number");
  });

  it("returns null for an unknown hash", async () => {
    expect(await getAttestation(hashMessageContent("never-recorded"))).toBeNull();
  });

  it("batch-gets only the recorded hashes", async () => {
    const h1 = hashMessageContent("one");
    const h2 = hashMessageContent("two");
    const h3 = hashMessageContent("three");
    await recordAttestation(h1, { payer: PAYER, author: "alice", topic: TOPIC, txId: TXID });
    await recordAttestation(h3, { payer: PAYER, author: "carol", topic: TOPIC, txId: TXID });
    const map = await getAttestations([h1, h2, h3]);
    expect(map.size).toBe(2);
    expect(map.get(h1)!.author).toBe("alice");
    expect(map.get(h3)!.author).toBe("carol");
    expect(map.has(h2)).toBe(false);
  });
});

describe("write path (verifyUserHcsTx)", () => {
  it("records an attestation with the resolved payer and on-chain author", async () => {
    const hcs = new MemoryHcsClient();
    const message = {
      v: 1,
      kind: "rep-vote",
      ts: "2026-09-10T00:00:00Z",
      author: "alice",
      target: "bob",
      voter: "alice",
      value: 1,
    };
    hcs.__verifyTx(TXID, TOPIC, PAYER, message);
    const result = await verifyUserHcsTx(writeDeps(hcs), session, TXID, TOPIC, {
      author: "alice",
      target: "bob",
      voter: "alice",
      value: 1,
    });
    expect(result).toBeNull();
    const att = await getAttestation(hashMessageContent(JSON.stringify(message)));
    expect(att).toMatchObject({ payer: PAYER, author: "alice", topic: TOPIC, txId: TXID });
  });

  it("does not fail the write when the message is unparseable", async () => {
    const hcs = new MemoryHcsClient();
    // The "{}" dummy bypasses content checks; author is undefined → skip attestation.
    hcs.__verifyTx(TXID, TOPIC, PAYER);
    const result = await verifyUserHcsTx(writeDeps(hcs), session, TXID, TOPIC);
    expect(result).toBeNull();
    expect(await getAttestation(hashMessageContent("{}"))).toBeNull();
  });
});

describe("read path (MemoryHcsClient enrichment)", () => {
  it("attaches attestation to attested messages, leaves the field unset otherwise", async () => {
    const hcs = new MemoryHcsClient();
    const attestedMsg = { v: 1, kind: "chat", ts: "2026-09-10T00:00:00Z", author: "alice", room: "lobby", body: "hi" };
    const plainMsg = { v: 1, kind: "chat", ts: "2026-09-10T00:00:00Z", author: "mallory", room: "lobby", body: "forged" };
    hcs.seed(TOPIC, attestedMsg);
    hcs.seed(TOPIC, plainMsg);
    hcs.__attest(hashMessageContent(JSON.stringify(attestedMsg)), {
      payer: PAYER,
      author: "alice",
      topic: TOPIC,
      txId: TXID,
    });
    const [a, b] = await hcs.query(TOPIC);
    expect(a.attestation).toEqual({ payer: PAYER, author: "alice" });
    expect("attestation" in b).toBe(false);
  });

  it("enriches queryAll the same way", async () => {
    const hcs = new MemoryHcsClient();
    const m = { v: 1, kind: "chat", ts: "2026-09-10T00:00:00Z", author: "alice", room: "lobby", body: "hi" };
    hcs.seed(TOPIC, m);
    hcs.__attest(hashMessageContent(JSON.stringify(m)), {
      payer: PAYER,
      author: "alice",
      topic: TOPIC,
      txId: TXID,
    });
    const [got] = await hcs.queryAll(TOPIC);
    expect(got.attestation).toEqual({ payer: PAYER, author: "alice" });
  });
});

describe("isAttestedVote / isAuthorVerified", () => {
  const contents = { v: 1 as const, kind: "rep-vote" as const, ts: "x", author: "alice", target: "bob", voter: "alice", value: 1 as const };
  it("accepts matching attested votes", () => {
    expect(isAttestedVote({ attestation: { payer: PAYER, author: "alice" } }, "alice")).toBe(true);
    expect(isAttestedVote({ attestation: { payer: PAYER, author: "ALICE" } }, "alice")).toBe(true); // case-insensitive
  });
  it("rejects unattested or mismatched votes", () => {
    expect(isAttestedVote({}, "alice")).toBe(false);
    expect(isAttestedVote({ attestation: { payer: PAYER, author: "mallory" } }, "alice")).toBe(false);
  });
  it("flags verified authors, not unverified ones", () => {
    expect(isAuthorVerified({ contents, attestation: { payer: PAYER, author: "alice" } })).toBe(true);
    expect(isAuthorVerified({ contents })).toBe(false);
    expect(isAuthorVerified({ contents, attestation: { payer: PAYER, author: "mallory" } })).toBe(false);
  });
});
