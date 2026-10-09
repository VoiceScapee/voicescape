/**
 * Tests for the HCS-27 checkpoint pure module.
 *
 * Golden values below were cross-checked against an independent Python
 * implementation (hashlib) — see the task notes. The tree construction
 * follows the HCS-27 draft merkle-profile.md ("HCS-27 Merkle v1").
 */
import { describe, expect, it } from "vitest";
import {
  assembleJws,
  buildCheckpoint,
  buildSthPayload,
  fromB64u,
  jcs,
  leafHash,
  merkleProof,
  merkleRoot,
  merkleRootOfEntries,
  nodeHash,
  parseJws,
  sthSigningInput,
  toB64Std,
  toB64u,
  verifyCheckpoint,
  verifyMerkleProof,
  verifySthSignature,
  type CheckpointMessage,
} from "./checkpoint";

describe("jcs (RFC 8785)", () => {
  it("sorts keys recursively, no whitespace", () => {
    expect(jcs({ b: 1, a: { z: [3, 2], y: "x" } })).toBe(
      '{"a":{"y":"x","z":[3,2]},"b":1}',
    );
  });
  it("escapes only what JCS requires", () => {
    expect(jcs({ s: 'a"b\\c' })).toBe('{"s":"a\\"b\\\\c"}');
    expect(jcs({ s: "a/b" })).toBe('{"s":"a/b"}'); // never escape /
    expect(jcs({ s: "héllo🦎" })).toBe('{"s":"héllo🦎"}'); // raw UTF-8 out
    expect(jcs({ s: "a\x01b" })).toBe('{"s":"a\\u0001b"}'); // control -> \u00xx
  });
  it("serializes numbers in shortest round-trip form", () => {
    expect(jcs({ n: 1.0 })).toBe('{"n":1}');
    expect(jcs({ n: -0 })).toBe('{"n":0}');
    expect(jcs({ n: 0.1 })).toBe('{"n":0.1}');
  });
  it("rejects non-finite numbers and undefined", () => {
    expect(() => jcs({ n: NaN })).toThrow();
    expect(() => jcs({ n: Infinity })).toThrow();
    expect(() => jcs({ u: undefined })).toThrow();
  });
});

describe("leaf hashing (draft: SHA256(0x00 || JCS))", () => {
  it("is byte-exact against the independent Python implementation", () => {
    const entry = {
      type: "voicescape.tipping_review.v1",
      reviewer: "io.github.VoiceScapee/voicescape",
      subject: "0.0.12345",
      verdict: "clean",
      report_hash: "abc123",
      attested_at: "2026-10-08T20:00:00.000Z",
      demo: true,
    };
    expect(leafHash(entry).toString("hex")).toBe(
      "74239c7931f5fe0bbeb88f987ccc1ea3a25ddeff5b74f2dd93a3254517654825",
    );
  });
  it("differs from a plain sha256 (0x00 prefix matters)", () => {
    const { createHash } = require("node:crypto");
    const e = { a: 1 };
    const plain = createHash("sha256").update(jcs(e), "utf8").digest("hex");
    expect(leafHash(e).toString("hex")).not.toBe(plain);
  });
});

describe("merkle tree (draft: RFC 9162 §2)", () => {
  const e = (n: number, v = "x") => ({ n, v });
  it("single leaf root is the leaf hash", () => {
    const h = leafHash(e(0));
    expect(merkleRoot([h]).equals(h)).toBe(true);
  });
  it("two leaves: SHA256(0x01 || L || R)", () => {
    const l = leafHash(e(0));
    const r = leafHash(e(1));
    expect(merkleRoot([l, r]).equals(nodeHash(l, r))).toBe(true);
  });
  it("three leaves match the Python reference (split at 2, not pairwise)", () => {
    const entries = [e(1, "a"), e(2, "b"), e(3, "c")];
    expect(merkleRootOfEntries(entries).toString("hex")).toBe(
      "0658bc51db47468a42b1bc6a18aba7e560b382d29f827967b59967046cce3532",
    );
    expect(toB64u(merkleRootOfEntries(entries))).toBe(
      "Bli8UdtHRopCsbxqGKun5WCzgtKfgnlntZlnBGzONTI",
    );
  });
  it("five leaves split at largest power of two < 5 (k=4)", () => {
    const entries = [0, 1, 2, 3, 4].map((n) => ({ n }));
    expect(merkleRootOfEntries(entries).toString("hex")).toBe(
      "87d50c5ea4b4e9c66a6350dc9cf80c85641a6dc2d4e86fbeeedca752fa4cdb4c",
    );
  });
  it("takes leaves in caller order — no sorting (R1, matches standards-sdk)", () => {
    const a = [{ n: 2 }, { n: 1 }];
    const b = [{ n: 1 }, { n: 2 }];
    // Different order -> different root. The caller owns ordering.
    expect(merkleRootOfEntries(a).toString("hex")).not.toBe(
      merkleRootOfEntries(b).toString("hex"),
    );
  });
  it("throws on empty leaf set", () => {
    expect(() => merkleRoot([])).toThrow();
  });
});

describe("merkle inclusion proofs (RFC 9162)", () => {
  const entries = [0, 1, 2, 3, 4].map((n) => ({ n }));
  const hashes = entries.map(leafHash);
  const root = merkleRoot(hashes);
  it("proves every leaf in a 5-leaf tree", () => {
    for (let i = 0; i < 5; i++) {
      const proof = merkleProof(hashes, i);
      expect(proof.leafIndex).toBe(i);
      expect(proof.treeSize).toBe(5);
      expect(verifyMerkleProof(root, entries[i], proof)).toBe(true);
    }
  });
  it("rejects a tampered entry", () => {
    const proof = merkleProof(hashes, 2);
    expect(verifyMerkleProof(root, { n: 999 }, proof)).toBe(false);
  });
  it("rejects a wrong root", () => {
    const proof = merkleProof(hashes, 0);
    const other = merkleRoot(hashes.slice(0, 4));
    expect(verifyMerkleProof(other, entries[0], proof)).toBe(false);
  });
});

describe("buildCheckpoint (pure — never signs)", () => {
  const entries = [
    { type: "demo", n: 1 },
    { type: "demo", n: 2 },
  ];
  it("builds an unsigned checkpoint with the declared topics (R2, R3)", () => {
    const { message, sthPayload } = buildCheckpoint({
      topics: [{ id: "0.0.10908351", seqRange: [1, 2] }],
      entries,
      timestamp: "2026-10-08T21:00:00.000Z",
      demo: true,
      inlineEntries: true,
    });
    expect(message.type).toBe("voicescape.checkpoint.v1");
    expect(message.sig).toBeNull(); // fee model: publisher signs, never the server
    expect(message.topics).toEqual([{ id: "0.0.10908351", seqRange: [1, 2] }]);
    expect(message.treeSize).toBe(2);
    expect(message.root).toBe(toB64u(merkleRootOfEntries(entries)));
    expect(message.entries).toEqual(entries);
    expect(message.prev).toBeNull(); // genesis
    // STH payload: five normative fields + topics claim (R7)
    expect(sthPayload.checkpointFormat).toBe("hcs-27/v1");
    expect(sthPayload.treeSize).toBe(2);
    expect(sthPayload.topics).toEqual(message.topics);
    expect(sthPayload.rootHash).toBe(toB64Std(fromB64u(message.root)));
  });
  it("STH payload is deterministic", () => {
    const a = buildCheckpoint({
      topics: [{ id: "0.0.1", seqRange: [1, 1] }],
      entries: [{ x: 1 }],
      timestamp: "2026-10-08T21:00:00.000Z",
    });
    const b = buildCheckpoint({
      topics: [{ id: "0.0.1", seqRange: [1, 1] }],
      entries: [{ x: 1 }],
      timestamp: "2026-10-08T21:00:00.000Z",
    });
    expect(jcs(a.sthPayload)).toBe(jcs(b.sthPayload));
    expect(a.message.root).toBe(b.message.root);
  });
});

describe("STH JWS round-trip", () => {
  it("assembles and parses a compact JWS", async () => {
    // secp256k1 test key (DO NOT USE — test only)
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const priv = new Uint8Array(32).fill(7);
    const pub = secp256k1.getPublicKey(priv, true);
    const header = {
      alg: "ES256K",
      kid: Buffer.from(pub).toString("hex"),
      typ: "JWT" as const,
      timestamp: 1791490000,
    };
    const payload = {
      checkpointFormat: "hcs-27/v1",
      origin: "voicescape",
      rootHash: toB64Std(Buffer.alloc(32, 1)),
      timestamp: 1791490000,
      treeSize: 2,
      topics: [{ id: "0.0.1", seqRange: [1, 2] as [number, number] }],
    };
    const input = sthSigningInput(header, payload);
    const msgHash = (await import("node:crypto")).createHash("sha256").update(input).digest();
    const sig = secp256k1.sign(msgHash, priv);
    const jws = assembleJws(input, sig.toCompactRawBytes());
    const parsed = parseJws(jws);
    expect(parsed.header.alg).toBe("ES256K");
    expect(parsed.payload.treeSize).toBe(2);
    expect(
      await verifySthSignature(parsed.signingInput, parsed.signature, "ES256K", pub),
    ).toBe(true);
    // Tampered payload fails
    const bad = { ...parsed, signature: Buffer.from(parsed.signature) };
    bad.signature[0] ^= 0xff;
    expect(
      await verifySthSignature(parsed.signingInput, bad.signature, "ES256K", pub),
    ).toBe(false);
  });
});

describe("verifyCheckpoint (9-step)", () => {
  const entries = [{ type: "demo", n: 1 }, { type: "demo", n: 2 }, { type: "demo", n: 3 }];
  const topics = [{ id: "0.0.10908351", seqRange: [1, 3] as [number, number] }];

  function demoMessage(): CheckpointMessage {
    const { message } = buildCheckpoint({
      topics,
      entries,
      timestamp: "2026-10-08T21:00:00.000Z",
      demo: true,
      inlineEntries: true,
    });
    return message;
  }

  const noSigDeps = {
    fetchRange: async () => [],
    latestSequence: async () => null,
  };

  it("fails cleanly on an unsigned checkpoint (signature required, not ignored)", async () => {
    const report = await verifyCheckpoint(demoMessage(), noSigDeps);
    expect(report.ok).toBe(false);
    expect(report.steps.some((s) => s.step === "digest" && !s.ok)).toBe(true);
  });

  it("rejects a tampered leaf at recompute (signed message)", async () => {
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const { createHash } = await import("node:crypto");
    const priv = new Uint8Array(32).fill(13);
    const pub = secp256k1.getPublicKey(priv, true);
    const kid = Buffer.from(pub).toString("hex");

    const { message, sthPayload } = buildCheckpoint({
      topics: [{ id: "0.0.10908351", seqRange: [1, 3] }],
      entries,
      timestamp: "2026-10-08T21:00:00.000Z",
      demo: true,
      inlineEntries: true,
    });
    const header = { alg: "ES256K", kid, typ: "JWT" as const, timestamp: sthPayload.timestamp };
    const input = sthSigningInput(header, sthPayload);
    const sig = secp256k1.sign(createHash("sha256").update(input).digest(), priv);
    message.sig = assembleJws(input, sig.toCompactRawBytes());

    // Tamper AFTER signing: the digest still verifies (topics unchanged),
    // but the recomputed root must not match.
    (message.entries as unknown[])[2] = { type: "demo", n: 999 };
    const report = await verifyCheckpoint(message, {
      ...noSigDeps,
      resolveKid: async (k) => (k === kid ? pub : null),
    });
    expect(report.ok).toBe(false);
    expect(report.steps.some((s) => s.step === "recompute" && !s.ok)).toBe(true);
  });

  it("detects a tessellation gap against the previous checkpoint", async () => {
    const prev = demoMessage(); // covers [1,3]
    const cur = buildCheckpoint({
      topics: [{ id: "0.0.10908351", seqRange: [5, 6] }], // gap: should start at 4
      entries: [{ type: "demo", n: 5 }, { type: "demo", n: 6 }],
      timestamp: "2026-10-08T22:00:00.000Z",
      demo: true,
      inlineEntries: true,
    }).message;
    const report = await verifyCheckpoint(cur, noSigDeps, prev);
    expect(report.ok).toBe(false);
    expect(report.steps.some((s) => s.step === "tessellation" && !s.ok)).toBe(true);
  });

  it("passes tessellation when ranges are contiguous", async () => {
    const prev = demoMessage(); // [1,3]
    const cur = buildCheckpoint({
      topics: [{ id: "0.0.10908351", seqRange: [4, 5] }],
      entries: [{ type: "demo", n: 4 }, { type: "demo", n: 5 }],
      timestamp: "2026-10-08T22:00:00.000Z",
      demo: true,
      inlineEntries: true,
    }).message;
    const report = await verifyCheckpoint(cur, noSigDeps, prev);
    // Still fails overall (unsigned), but tessellation itself passes.
    expect(report.steps.some((s) => s.step === "tessellation" && s.ok)).toBe(true);
  });

  it("surfaces (not fails) a dropped topic id (R9b)", async () => {
    const prev = buildCheckpoint({
      topics: [
        { id: "0.0.1", seqRange: [1, 2] },
        { id: "0.0.2", seqRange: [1, 1] },
      ],
      entries: [{ a: 1 }, { a: 2 }, { b: 1 }],
      timestamp: "2026-10-08T21:00:00.000Z",
      demo: true,
      inlineEntries: true,
    }).message;
    const cur = buildCheckpoint({
      topics: [{ id: "0.0.1", seqRange: [3, 3] }],
      entries: [{ a: 3 }],
      timestamp: "2026-10-08T22:00:00.000Z",
      demo: true,
      inlineEntries: true,
    }).message;
    const report = await verifyCheckpoint(cur, noSigDeps, prev);
    const topo = report.steps.find((s) => s.step === "topology");
    expect(topo?.ok).toBe(true);
    expect(topo?.detail).toContain("coverage change");
    expect(topo?.detail).toContain("0.0.2");
  });

  it("rejects a short read from the topic (R6)", async () => {
    const { message } = buildCheckpoint({
      topics: [{ id: "0.0.9", seqRange: [1, 3] }],
      entries, // tree built over 3, but fetch returns 2
      timestamp: "2026-10-08T21:00:00.000Z",
    });
    const report = await verifyCheckpoint(message, {
      fetchRange: async () => [
        { sequence_number: 1, message: Buffer.from(JSON.stringify(entries[0])) },
        { sequence_number: 2, message: Buffer.from(JSON.stringify(entries[1])) },
      ],
      latestSequence: async () => 3,
    });
    expect(report.ok).toBe(false);
    expect(report.steps.some((s) => s.step === "element-wise" && !s.ok)).toBe(true);
  });

  it("rejects swapped topic order via the digest topics claim (R7)", async () => {
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const { createHash } = await import("node:crypto");
    const priv = new Uint8Array(32).fill(17);
    const pub = secp256k1.getPublicKey(priv, true);
    const kid = Buffer.from(pub).toString("hex");

    const twoTopics = [
      { id: "0.0.1", seqRange: [1, 1] as [number, number] },
      { id: "0.0.2", seqRange: [1, 1] as [number, number] },
    ];
    const { message, sthPayload } = buildCheckpoint({
      topics: twoTopics,
      entries: [{ a: 1 }, { b: 1 }],
      timestamp: "2026-10-08T21:00:00.000Z",
      demo: true,
      inlineEntries: true,
    });
    const header = { alg: "ES256K", kid, typ: "JWT" as const, timestamp: sthPayload.timestamp };
    const input = sthSigningInput(header, sthPayload);
    const sig = secp256k1.sign(createHash("sha256").update(input).digest(), priv);
    message.sig = assembleJws(input, sig.toCompactRawBytes());

    // Sanity: the payload carries the declared order.
    expect(sthPayload.topics[0].id).toBe("0.0.1");

    // Swap the declaration order AFTER signing. The leaves are the same
    // (recompute passes), but the STH topics claim no longer deep-equals
    // the message's topics array — the swapped order cannot verify clean.
    message.topics = [...message.topics].reverse();
    const report = await verifyCheckpoint(message, {
      ...noSigDeps,
      resolveKid: async (k) => (k === kid ? pub : null),
    });
    expect(report.ok).toBe(false);
    expect(report.steps.some((s) => s.step === "digest" && !s.ok)).toBe(true);
  });

  it("full round-trip: build, sign (test key), verify passes", async () => {
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const { createHash } = await import("node:crypto");
    const priv = new Uint8Array(32).fill(11);
    const pub = secp256k1.getPublicKey(priv, true);
    const kid = Buffer.from(pub).toString("hex");

    const { message, sthPayload } = buildCheckpoint({
      topics: [{ id: "0.0.10908351", seqRange: [1, 3] }],
      entries,
      timestamp: "2026-10-08T21:00:00.000Z",
      demo: true,
      inlineEntries: true,
    });
    const header = { alg: "ES256K", kid, typ: "JWT" as const, timestamp: sthPayload.timestamp };
    const input = sthSigningInput(header, sthPayload);
    const sig = secp256k1.sign(createHash("sha256").update(input).digest(), priv);
    message.sig = assembleJws(input, sig.toCompactRawBytes());

    const report = await verifyCheckpoint(message, {
      ...noSigDeps,
      resolveKid: async (k) => (k === kid ? pub : null),
    });
    expect(report.steps.map((s) => `${s.step}:${s.ok}`).join(" ")).toBe(
      "topology:true tessellation:true fetch:true element-wise:true staleness:true recompute:true digest:true prev:true",
    );
    expect(report.ok).toBe(true);
  });
});

describe("fee model (Brandon's rule)", () => {
  it("buildCheckpoint never signs — sig is always null", () => {
    const { message } = buildCheckpoint({
      topics: [{ id: "0.0.1", seqRange: [1, 1] }],
      entries: [{ x: 1 }],
    });
    expect(message.sig).toBeNull();
  });
  it("the checkpoint module imports no signing or network", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(__dirname + "/checkpoint.ts", "utf8");
    expect(src).not.toMatch(/PrivateKey/);
    expect(src).not.toMatch(/TopicMessageSubmitTransaction/);
    expect(src).not.toMatch(/fetch\(/);
  });
});
