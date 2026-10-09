/**
 * Voicescape HCS-27 Checkpoint — pure computation module.
 *
 * Builds and verifies review-attestation checkpoints per
 * `workspace/goals/make-voicescape-go-viral/hidden_files/hcs27-checkpoint-extension.md`.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FEE MODEL (Brandon's rule — the dapp never pays for user actions)   │
 * │                                                                     │
 * │ This module NEVER signs, NEVER submits, NEVER pays. It only         │
 * │ computes: leaves -> Merkle tree -> checkpoint message.              │
 * │                                                                     │
 * │ - Attesters pay for their own attestation HCS messages. The         │
 * │   `review_agent_tipping` tool returns UNSIGNED bytes; the caller    │
 * │   signs with their own key and pays their own ~$0.0001.             │
 * │ - Publishers pay for their own checkpoint HCS messages (~$0.0001).  │
 * │   Anyone can compute a checkpoint with `buildCheckpoint` (or the    │
 * │   `build_checkpoint` MCP tool) and publish it themselves.           │
 * │ - There is NO server-operated publisher. The server holds no keys.  │
 * │                                                                     │
 * │ Truly $0 is impossible — Hedera charges ~$0.0001 per HCS message,   │
 * │ a network rule. But the dapp's cost is $0: every fee lands on the   │
 * │ party taking the action.                                           │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * STANDARDS (quoted where it matters):
 *
 * - Merkle construction: HCS-27 draft `merkle-profile.md`
 *   ("HCS-27 Merkle v1", hiero-ledger/hiero-consensus-specifications):
 *   "The hash function MUST be SHA-256."
 *   "LeafHash = SHA256(0x00 || canonical_entry_bytes)" where the entry is
 *   JCS-canonicalized UTF-8.
 *   "H_node(L, R) = SHA256(0x01 || L || R)".
 *   Tree shape is "equivalent to the Merkle Tree Hash defined in
 *   RFC 9162 §2" — split at the largest power of two strictly less than n.
 * - Entry canonicalization: JCS (RFC 8785), minimal implementation below
 *   for our entry shapes. Byte-exact; golden vectors in checkpoint.test.ts.
 * - Encodings (draft): leafHash lowercase hex; rootHashB64u on-ledger
 *   base64url no padding; STH payload rootHash standard base64.
 *
 * EXTENSION (our rules, labeled — NOT implied HCS-27 conformance):
 *
 * - R1: leaf order = HCS consensus sequence ascending. The tree builder
 *   takes leaves in caller order and does NOT sort — this matches
 *   hashgraph-online/standards-sdk `src/hcs-27/merkle.ts`, which builds
 *   in raw array order, zero sorting. Callers MUST pass leaves in
 *   consensus-sequence order (the MCP tool and verifier do).
 * - R2/R3: every checkpoint declares its covered topics as an ordered
 *   top-level `topics: [{id, seqRange: [start, end]}]` array.
 * - R5: tessellation — checkpoint n+1's start == checkpoint n's end+1 per
 *   shared topic id. Complements (not duplicates) the draft's `prev`
 *   root chaining: `prev` commits to what was fetched, tessellation
 *   checks what wasn't silently dropped.
 * - R6: element-wise sequence assertion, not just count matching.
 * - R7: the topics array (ordering included) rides inside the STH JWS
 *   payload as a `topics` claim, via the draft's sanctioned hook:
 *   "Implementations that provide checkpoint signatures SHOULD expose
 *   ... signature payload construction rules if they differ from the
 *   recommended payload" (index.md). Draft-only verifiers stay
 *   conformant (their normative checks ignore the extra claim).
 * - R8: staleness checkable from the mirror alone.
 * - R9: membership transitions — new topic id starts its own chain;
 *   dropped id is a loud coverage-change event, never silent.
 */

import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ */
/* JCS (RFC 8785) — minimal, strict, for JSON-serializable entries.    */
/*                                                                     */
/* Rules implemented:                                                  */
/* - No whitespace. Object keys sorted by UTF-16 code units.           */
/* - Strings: escape only `"`, `\`, and U+0000–U+001F (as \u00xx,       */
/*   lowercase hex). Never escape `/` or non-ASCII (raw UTF-8 out).    */
/* - Numbers: finite only (NaN/Infinity throw); shortest round-trip     */
/*   form (JSON.stringify already does this; -0 serializes as "0").    */
/* - No undefined/functions/symbols (throw — silent corruption is      */
/*   worse than a loud failure for a hashing input).                    */
/* ------------------------------------------------------------------ */

/** Canonical JSON per RFC 8785 (subset sufficient for our entries). */
export function jcs(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return jcsString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("jcs: non-finite numbers are not allowed");
    }
    // JSON.stringify gives shortest round-trip; -0 -> "0" per RFC 8785.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(jcs).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return (
      "{" +
      keys
        .map((k) => jcsString(k) + ":" + jcs((value as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error(`jcs: unsupported value type ${typeof value}`);
}

function jcsString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (s[i] === '"') out += '\\"';
    else if (s[i] === "\\") out += "\\\\";
    else if (c < 0x20) {
      out += "\\u" + c.toString(16).padStart(4, "0");
    } else {
      out += s[i];
    }
  }
  return out + '"';
}

/* ------------------------------------------------------------------ */
/* Merkle hashing — HCS-27 draft merkle-profile.md, "HCS-27 Merkle v1". */
/* ------------------------------------------------------------------ */

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Draft: "LeafHash = SHA256(0x00 || canonical_entry_bytes)".
 * The entry is JCS-canonicalized first (draft: "after JCS canonicalization").
 */
export function leafHash(entry: unknown): Buffer {
  const canonical = Buffer.from(jcs(entry), "utf8");
  return sha256(Buffer.concat([Buffer.from([0x00]), canonical]));
}

/** Draft: "H_node(L, R) = SHA256(0x01 || L || R)". */
export function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha256(Buffer.concat([Buffer.from([0x01]), left, right]));
}

function largestPowerOfTwoLessThan(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * Merkle root over leaf hashes, RFC 9162 §2 (draft: "equivalent to the
 * Merkle Tree Hash defined in RFC 9162 §2").
 *
 * EXTENSION note (R1): leaves are taken in caller order — NO sorting.
 * This matches standards-sdk merkle.ts (raw array order). Callers MUST
 * pass leaves in HCS consensus-sequence ascending order.
 */
export function merkleRoot(leafHashes: Buffer[]): Buffer {
  if (leafHashes.length === 0) {
    throw new Error("merkleRoot: empty leaf set (treeSize 0 is undefined)");
  }
  if (leafHashes.length === 1) return leafHashes[0];
  const k = largestPowerOfTwoLessThan(leafHashes.length);
  const left = merkleRoot(leafHashes.slice(0, k));
  const right = merkleRoot(leafHashes.slice(k));
  return nodeHash(left, right);
}

/** Convenience: entries -> JCS -> leaf hashes -> root. */
export function merkleRootOfEntries(entries: unknown[]): Buffer {
  return merkleRoot(entries.map(leafHash));
}

/** Draft encoding: rootHashB64u on-ledger = base64url, no padding. */
export function toB64u(hash: Buffer): string {
  return hash.toString("base64url");
}

/** Draft: STH payload rootHash is standard base64 (with padding). */
export function toB64Std(hash: Buffer): string {
  return hash.toString("base64");
}

export function fromB64u(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/* ------------------------------------------------------------------ */
/* Merkle inclusion proofs — RFC 9162 §2.1, draft proof object shape.  */
/* ------------------------------------------------------------------ */

export interface InclusionProof {
  leafHash: string; // lowercase hex (draft)
  leafIndex: number;
  treeSize: number;
  /** Sibling hashes leaf-to-root, standard base64 (draft). Empty for size-1 trees. */
  path: string[];
}

/**
 * Inclusion proof for the leaf at `index`. Path entries are ordered
 * leaf-to-root, exactly as consumed by verification.
 */
export function merkleProof(leafHashes: Buffer[], index: number): InclusionProof {
  if (index < 0 || index >= leafHashes.length) {
    throw new Error("merkleProof: index out of range");
  }
  const path: Buffer[] = [];
  proveRecursive(leafHashes, index, path);
  return {
    leafHash: leafHashes[index].toString("hex"),
    leafIndex: index,
    treeSize: leafHashes.length,
    path: path.map((b) => b.toString("base64")),
  };
}

function proveRecursive(hashes: Buffer[], index: number, path: Buffer[]): Buffer {
  if (hashes.length === 1) return hashes[0];
  const k = largestPowerOfTwoLessThan(hashes.length);
  if (index < k) {
    const leftRoot = proveRecursive(hashes.slice(0, k), index, path);
    const rightRoot = merkleRoot(hashes.slice(k));
    path.push(rightRoot);
    return nodeHash(leftRoot, rightRoot);
  }
  const leftRoot = merkleRoot(hashes.slice(0, k));
  const rightRoot = proveRecursive(hashes.slice(k), index - k, path);
  path.push(leftRoot);
  return nodeHash(leftRoot, rightRoot);
}

/**
 * Verify an inclusion proof per RFC 9162. The path carries sibling hashes
 * only (draft format); positions are recovered by simulating the
 * deterministic descent from (leafIndex, treeSize), since the RFC 9162
 * tree shape is a pure function of (index, size).
 */
export function verifyMerkleProof(
  root: Buffer,
  entry: unknown,
  proof: InclusionProof,
): boolean {
  // Simulate the root-to-leaf descent, recording at each level whether
  // we went left (sibling is right) or right (sibling is left).
  const wentLeft: boolean[] = [];
  let idx = proof.leafIndex;
  let n = proof.treeSize;
  while (n > 1) {
    const k = largestPowerOfTwoLessThan(n);
    if (idx < k) {
      wentLeft.push(true);
      n = k;
    } else {
      wentLeft.push(false);
      idx -= k;
      n -= k;
    }
  }
  // The proof path is ordered leaf-to-root; descent was root-to-leaf.
  wentLeft.reverse();
  if (wentLeft.length !== proof.path.length) return false;
  let h = leafHash(entry);
  for (let i = 0; i < proof.path.length; i++) {
    const sib = Buffer.from(proof.path[i], "base64");
    h = wentLeft[i] ? nodeHash(h, sib) : nodeHash(sib, h);
  }
  return h.equals(root);
}

/* ------------------------------------------------------------------ */
/* Checkpoint message — per the extension spec (R2, R3, R7).           */
/*                                                                     */
/* EXTENSION (labeled): the draft defines `metadata.stream`, `root`,   */
/* `prev`, `sig` but says nothing about which topics a checkpoint      */
/* covers. Every checkpoint here declares its covered topics as an     */
/* ordered top-level array. Draft-only consumers MUST ignore unknown   */
/* fields (draft index.md), so this stays conformant.                  */
/* ------------------------------------------------------------------ */

export interface CheckpointTopicRange {
  /** HCS topic id, e.g. "0.0.10908351". */
  id: string;
  /**
   * EXTENSION (R3): inclusive consensus-sequence range covered.
   * [start, end] with start > end denotes an explicitly empty range.
   */
  seqRange: [number, number];
}

export interface CheckpointMessage {
  type: "voicescape.checkpoint.v1";
  /** Demo/self-contained mode: leaves carried inline, not fetched. */
  demo?: boolean;
  /**
   * Draft `metadata.stream`. EXTENSION: v1 has no on-chain registry
   * contract; these are logical identifiers, labeled as such.
   */
  stream: { registry: string; log_id: string };
  /** EXTENSION (R2, R3, R7): ordered declaration; order IS reassembly order. */
  topics: CheckpointTopicRange[];
  treeSize: number;
  /** rootHashB64u (draft encoding: base64url, no padding). */
  root: string;
  /**
   * Draft chaining: previous checkpoint's (treeSize, rootHashB64u).
   * Null for genesis. treeSize here is the draft's base-10 string form.
   */
  prev: null | { treeSize: string; rootHashB64u: string };
  /** ISO-8601 checkpoint time. */
  timestamp: string;
  /**
   * Demo/self-contained mode only: the covered entries inline, in
   * consensus order. Production checkpoints omit this; verifiers fetch
   * from the topic per the declared ranges (R3).
   */
  entries?: unknown[];
  /**
   * Compact JWS over the STH payload (R7). Null until the publisher
   * signs — `buildCheckpoint` never signs (fee model: the publisher,
   * not the server, signs and pays).
   */
  sig: string | null;
}

export interface BuildCheckpointInput {
  stream?: { registry: string; log_id: string };
  topics: CheckpointTopicRange[];
  /** Entries in HCS consensus-sequence ascending order (R1 — no sorting). */
  entries: unknown[];
  prev?: CheckpointMessage["prev"];
  timestamp?: string;
  demo?: boolean;
  /** Demo mode: carry entries inline so the message is self-verifying. */
  inlineEntries?: boolean;
}

/**
 * Pure: entries -> Merkle tree -> checkpoint message (UNSIGNED).
 *
 * The publisher signs the STH payload (see `sthSigningInput`) with their
 * own key and publishes the message themselves, paying their own ~$0.0001.
 * This function never touches a private key.
 */
export function buildCheckpoint(input: BuildCheckpointInput): {
  message: CheckpointMessage;
  /** Exact bytes the publisher signs (JWS signing input). */
  sthPayload: SthPayload;
} {
  const { topics, entries } = input;
  if (entries.length === 0) {
    throw new Error("buildCheckpoint: need at least one entry (demo carries entries inline)");
  }
  const root = merkleRootOfEntries(entries);
  const timestamp = input.timestamp ?? new Date().toISOString();
  const treeSize = entries.length;
  const message: CheckpointMessage = {
    type: "voicescape.checkpoint.v1",
    stream: input.stream ?? { registry: "voicescape", log_id: "review-attestations" },
    topics,
    treeSize,
    root: toB64u(root),
    prev: input.prev ?? null,
    timestamp,
    sig: null,
  };
  if (input.demo) message.demo = true;
  if (input.inlineEntries) message.entries = entries;
  const sthPayload = buildSthPayload(message, root);
  return { message, sthPayload };
}

/* ------------------------------------------------------------------ */
/* STH payload — draft normative five fields + topics claim (R7).      */
/*                                                                     */
/* Draft merkle-profile.md "Signed Tree Head (Normative)": the STH     */
/* "cryptographically binds a checkpoint's root hash and tree size to   */
/* the log operator's signing key" as a compact JWS. Payload fields:   */
/* checkpointFormat, origin, rootHash (standard base64), timestamp     */
/* (unix seconds, JSON integer), treeSize (JSON integer).              */
/*                                                                     */
/* EXTENSION (R7) via the draft's sanctioned hook ("SHOULD expose      */
/* signature payload construction rules if they differ from the        */
/* recommended payload", index.md): our payload adds a `topics` claim  */
/* carrying the ordered declaration. A swapped concatenation order     */
/* cannot verify clean — the order is inside the signed payload.       */
/* Draft-only verifiers stay conformant: their four normative checks   */
/* (decode; rootHash match; treeSize match; signature verify) ignore   */
/* the extra claim.                                                    */
/* ------------------------------------------------------------------ */

export interface SthPayload {
  /** EXTENSION: our format id (draft example was "c2sp/v1"). */
  checkpointFormat: string;
  /** EXTENSION: our value (draft: FQDN of the log service). */
  origin: string;
  /** Draft: standard base64 root hash. */
  rootHash: string;
  /** Draft: unix epoch seconds, JSON integer. */
  timestamp: number;
  /** Draft: JSON integer. */
  treeSize: number;
  /** EXTENSION (R7): the ordered topics declaration. */
  topics: CheckpointTopicRange[];
}

export function buildSthPayload(
  message: CheckpointMessage,
  root?: Buffer,
): SthPayload {
  const rootBytes = root ?? fromB64u(message.root);
  return {
    checkpointFormat: "hcs-27/v1",
    origin: "voicescape",
    rootHash: toB64Std(rootBytes),
    timestamp: Math.floor(new Date(message.timestamp).getTime() / 1000),
    treeSize: message.treeSize,
    topics: message.topics,
  };
}

export interface JwsHeader {
  /** EXTENSION: "ES256K" for secp256k1 (draft example was ES256). */
  alg: string;
  /** Key identifier — we use the compressed public key hex. */
  kid: string;
  typ: "JWT";
  /** Draft header field: unix seconds when the STH was produced. */
  timestamp: number;
}

/**
 * Exact JWS signing input: ASCII(BASE64URL(JCS(header)) + "." +
 * BASE64URL(JCS(payload))). JCS (not plain JSON.stringify) so the
 * bytes-to-sign are deterministic for every publisher.
 */
export function sthSigningInput(header: JwsHeader, payload: SthPayload): Uint8Array {
  const enc = new TextEncoder();
  const h = Buffer.from(jcs(header), "utf8").toString("base64url");
  const p = Buffer.from(jcs(payload), "utf8").toString("base64url");
  return enc.encode(`${h}.${p}`);
}

/** Assemble a compact JWS from signing input + raw 64-byte R||S signature. */
export function assembleJws(signingInput: Uint8Array, signatureRaw: Uint8Array): string {
  const dec = new TextDecoder();
  return `${dec.decode(signingInput)}.${Buffer.from(signatureRaw).toString("base64url")}`;
}

export function parseJws(jws: string): {
  header: JwsHeader;
  payload: SthPayload;
  signingInput: Uint8Array;
  signature: Buffer;
} {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("parseJws: not a compact JWS");
  const enc = new TextEncoder();
  return {
    header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    signingInput: enc.encode(`${parts[0]}.${parts[1]}`),
    signature: Buffer.from(parts[2], "base64url"),
  };
}

/* ------------------------------------------------------------------ */
/* Verifier — the 9-step algorithm from the extension spec (§3).       */
/*                                                                     */
/* Pure apart from the injected mirror-node reads. Anyone (arion, an   */
/* agent, a user) can run this against the public mirror node — no     */
/* trust in us required.                                               */
/* ------------------------------------------------------------------ */

export interface MirrorMessage {
  sequence_number: number;
  /** Raw HCS message bytes (already base64-decoded from the mirror response). */
  message: Uint8Array;
}

export interface VerifierDeps {
  /**
   * Fetch HCS messages for one topic over an inclusive sequence range,
   * ascending. Production: mirror node
   * `/api/v1/topics/{id}/messages?order=asc&sequencenumber=gte:{s}&sequencenumber=lte:{e}`.
   */
  fetchRange: (topicId: string, start: number, end: number) => Promise<MirrorMessage[]>;
  /** Latest sequence number on a topic (staleness check, R8). Null when unknown. */
  latestSequence: (topicId: string) => Promise<number | null>;
  /**
   * Resolve a JWS `kid` to a public key for signature verification.
   * Demo: kid is the compressed secp256k1 public key hex.
   */
  resolveKid?: (kid: string) => Promise<Uint8Array | null>;
}

export interface VerifyStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  steps: VerifyStep[];
}

/**
 * Parse one fetched HCS message into a checkpoint entry object.
 * Production leaves are the attestation JSON payloads; the entry is the
 * parsed object (JCS-canonicalized at hash time per the draft).
 */
export function parseEntry(message: Uint8Array): unknown {
  return JSON.parse(Buffer.from(message).toString("utf8"));
}

function step(steps: VerifyStep[], name: string, ok: boolean, detail: string): void {
  steps.push({ step: name, ok, detail });
}

/**
 * Verify a checkpoint message. For demo/self-contained messages
 * (`entries` inline), the leaf set comes from the message; otherwise
 * leaves are fetched from the topic per the declared ranges (R3).
 *
 * The JWS signature is verified when `sig` is present and `resolveKid`
 * is provided; a missing signature is reported, not silently ignored.
 */
export async function verifyCheckpoint(
  message: CheckpointMessage,
  deps: VerifierDeps,
  prev: CheckpointMessage | null = null,
): Promise<VerifyReport> {
  const steps: VerifyStep[] = [];
  const fail = (name: string, detail: string) => {
    step(steps, name, false, detail);
    return { ok: false, steps };
  };

  /* -- Step 1: topology check (R9) -------------------------------- */
  if (prev) {
    const prevIds = new Set(prev.topics.map((t) => t.id));
    const curIds = new Set(message.topics.map((t) => t.id));
    for (const id of prevIds) {
      if (!curIds.has(id)) {
        // Loud coverage-change event, non-fatal (R9b).
        step(steps, "topology", true, `coverage change: ${id} absent from this checkpoint, present in previous — surfaced, not failed (R9)`);
      }
    }
    const newIds = [...curIds].filter((id) => !prevIds.has(id));
    if (newIds.length > 0) {
      step(steps, "topology", true, `new topic id(s) start their own chain (R9a): ${newIds.join(", ")}`);
    }
    if (prevIds.size > 0 && [...prevIds].every((id) => curIds.has(id))) {
      step(steps, "topology", true, "topic membership unchanged");
    }

    /* -- Step 2: tessellation (R5) ---------------------------------- */
    for (const t of message.topics) {
      const p = prev.topics.find((x) => x.id === t.id);
      if (!p) continue; // R9a: new id, no constraint on its first range
      const expected = p.seqRange[1] + 1;
      if (t.seqRange[0] !== expected) {
        return fail("tessellation", `topic ${t.id}: start ${t.seqRange[0]} != prev end+1 (${expected}) — gap or fork (R5)`);
      }
    }
    step(steps, "tessellation", true, "all shared topics tessellate (R5)");
  } else {
    step(steps, "topology", true, "genesis checkpoint — no previous to compare (R5 base case)");
    step(steps, "tessellation", true, "genesis — tessellation starts at checkpoint 2 (R5)");
  }

  /* -- Steps 3+4: fetch + element-wise assertion (R3, R6) ----------- */
  const leaves: unknown[] = [];
  if (message.entries) {
    // Demo/self-contained mode: the leaf set rides in the message.
    for (const e of message.entries) leaves.push(e);
    step(steps, "fetch", true, `self-contained: ${leaves.length} inline entries (demo mode)`);
    step(steps, "element-wise", true, "inline entries need no sequence assertion (demo mode)");
  } else {
    for (const t of message.topics) {
      const [start, end] = t.seqRange;
      if (start > end) {
        step(steps, "fetch", true, `topic ${t.id}: empty declared range [${start}, ${end}] — nothing to fetch`);
        continue;
      }
      const got = await deps.fetchRange(t.id, start, end);
      // R6: element-wise — every returned sequence number must equal the
      // declared value at its position. Short read or mismatch = failure.
      if (got.length !== end - start + 1) {
        return fail("element-wise", `topic ${t.id}: short read — got ${got.length}, declared ${end - start + 1} (R6)`);
      }
      for (let i = 0; i < got.length; i++) {
        if (got[i].sequence_number !== start + i) {
          return fail("element-wise", `topic ${t.id}: sequence mismatch at position ${i} — got ${got[i].sequence_number}, declared ${start + i} (R6)`);
        }
      }
      for (const m of got) leaves.push(parseEntry(m.message));
      step(steps, "fetch", true, `topic ${t.id}: fetched [${start}, ${end}] (${got.length} messages)`);
    }
    step(steps, "element-wise", true, "all returned sequence numbers match declared ranges (R6)");
  }

  /* -- Step 5: staleness (R8) --------------------------------------- */
  if (!message.entries) {
    for (const t of message.topics) {
      const latest = await deps.latestSequence(t.id);
      if (latest !== null && latest > t.seqRange[1]) {
        step(steps, "staleness", true, `topic ${t.id}: STALE — latest ${latest} > declared end ${t.seqRange[1]} (R8, informational)`);
      } else {
        step(steps, "staleness", true, `topic ${t.id}: not stale (latest ${latest ?? "unknown"})`);
      }
    }
  } else {
    step(steps, "staleness", true, "demo mode — staleness not applicable");
  }

  /* -- Steps 6+7: concatenate (R4) + recompute root ---------------- */
  // R4: concatenation order is the publisher's declaration (topics array order).
  if (leaves.length !== message.treeSize) {
    return fail("recompute", `leaf count ${leaves.length} != declared treeSize ${message.treeSize}`);
  }
  const recomputed = merkleRootOfEntries(leaves);
  if (toB64u(recomputed) !== message.root) {
    return fail("recompute", "recomputed root does not match declared root");
  }
  step(steps, "recompute", true, `root matches over ${leaves.length} leaves (treeSize ${message.treeSize})`);

  /* -- Step 8: digest check (R7) ------------------------------------ */
  if (!message.sig) {
    step(steps, "digest", false, "no signature present — checkpoint is UNSIGNED (publisher must sign the STH payload)");
    return { ok: false, steps };
  }
  let parsed: ReturnType<typeof parseJws>;
  try {
    parsed = parseJws(message.sig);
  } catch (e) {
    return fail("digest", `JWS parse failed: ${(e as Error).message}`);
  }
  // The topics claim must deep-equal the message's top-level topics array,
  // ordered, element-wise (R7). A swapped order cannot verify clean.
  if (jcs(parsed.payload.topics) !== jcs(message.topics)) {
    return fail("digest", "STH payload topics claim != message topics array (R7)");
  }
  // Draft STH verification steps 1-3: rootHash and treeSize binding.
  if (parsed.payload.rootHash !== toB64Std(recomputed)) {
    return fail("digest", "STH payload rootHash != recomputed root");
  }
  if (parsed.payload.treeSize !== message.treeSize) {
    return fail("digest", "STH payload treeSize != declared treeSize");
  }
  // Draft step 4: signature verifies with header.kid's key.
  if (!deps.resolveKid) {
    step(steps, "digest", true, "topics claim + rootHash + treeSize bind (R7); signature NOT checked — no resolveKid provided");
  } else {
    const pubkey = await deps.resolveKid(parsed.header.kid);
    if (!pubkey) {
      return fail("digest", `cannot resolve kid ${parsed.header.kid} to a public key`);
    }
    const okSig = await verifySthSignature(parsed.signingInput, parsed.signature, parsed.header.alg, pubkey);
    if (!okSig) return fail("digest", "STH JWS signature invalid");
    step(steps, "digest", true, `STH JWS verifies (alg ${parsed.header.alg}, kid ${parsed.header.kid}) (R7)`);
  }

  /* -- Step 9: draft checks (prev linkage) -------------------------- */
  if (message.prev && prev) {
    if (message.prev.rootHashB64u !== prev.root || message.prev.treeSize !== String(prev.treeSize)) {
      return fail("prev", "prev linkage does not match previous checkpoint's (treeSize, rootHashB64u)");
    }
    step(steps, "prev", true, "prev chains previous checkpoint root (draft)");
  } else if (!message.prev) {
    step(steps, "prev", true, "genesis — no prev (draft)");
  } else {
    step(steps, "prev", true, "prev present; no previous checkpoint supplied to check against");
  }

  return { ok: steps.every((s) => s.ok), steps };
}

/**
 * Verify an STH JWS signature. Pure (public key only — no secrets).
 * Supports ES256K (secp256k1 + SHA-256); ES256 (P-256) is accepted for
 * draft compatibility where the log operator uses it.
 */
export async function verifySthSignature(
  signingInput: Uint8Array,
  signature: Buffer,
  alg: string,
  publicKey: Uint8Array,
): Promise<boolean> {
  const msgHash = sha256(signingInput);
  try {
    if (alg === "ES256K") {
      const { secp256k1 } = await import("@noble/curves/secp256k1");
      // JWS ES256K: raw 64-byte R||S.
      if (signature.length !== 64) return false;
      const sig = secp256k1.Signature.fromCompact(signature);
      return secp256k1.verify(sig, msgHash, publicKey);
    }
    if (alg === "ES256") {
      const { p256 } = await import("@noble/curves/p256");
      if (signature.length !== 64) return false;
      const sig = p256.Signature.fromCompact(signature);
      return p256.verify(sig, msgHash, publicKey);
    }
  } catch {
    return false;
  }
  return false;
}
