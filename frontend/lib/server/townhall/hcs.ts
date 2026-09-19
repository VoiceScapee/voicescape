/**
 * Voicescape Social Town Hall — HCS query + verification.
 *
 * In the user-signed architecture, clients submit HCS messages directly via
 * their wallet. The server NEVER submits — it only queries (via the free
 * mirror node REST API) and verifies user-submitted transactions.
 *
 * The `HcsPort` interface is the seam tests mock; the real client is
 * `RealHcsClient` via `defaultHcsPort()`.
 */

import { mirrorBaseUrl, townhallNetwork } from "./topics";
import type { StoredMessage, TownhallMessage } from "./types";
import { globalHcsCache, type HcsCache } from "./hcs-cache";
import { verifyHcsTransaction, type VerifiedHcsTx } from "./hcs-verify";
import { getAttestations, hashMessageContent, type Attestation } from "./attestations";

export interface QueryOpts {
  /** Only messages with seq greater than this. */
  afterSeq?: number;
  /** Per-request page size (mirror node max 100). */
  limit?: number;
}

export interface HcsPort {
  /**
   * Verify a user-submitted HCS transaction.
   * Returns the verified details, or null if verification fails.
   */
  verifyTx(txId: string, expectedTopicId: string, expectedPayer: string): Promise<VerifiedHcsTx | null>;
  /** Query decoded messages in ascending seq order. */
  query<T = TownhallMessage>(topicId: string, opts?: QueryOpts): Promise<StoredMessage<T>[]>;
  /** Query everything (paginated), ascending seq order. */
  queryAll<T = TownhallMessage>(topicId: string, max?: number): Promise<StoredMessage<T>[]>;
}

interface MirrorMessage {
  consensus_timestamp: string;
  message: string; // base64
  sequence_number: number;
}

interface MirrorMessagesResponse {
  messages?: MirrorMessage[];
  links?: { next?: string | null };
}

function hcsNetwork(): string {
  // Network is still needed for mirror node URL selection.
  // The client-side submit uses the wallet's network.
  return townhallNetwork();
}

export function isValidEnvelope(raw: unknown): raw is TownhallMessage {
  if (typeof raw !== "object" || raw === null) return false;
  const m = raw as Record<string, unknown>;
  return m.v === 1 && typeof m.kind === "string" && typeof m.author === "string" && typeof m.ts === "string";
}

function decodeMirrorMessage(topicId: string, m: MirrorMessage): { stored: StoredMessage; raw: string } | null {
  // Hash the EXACT bytes that were base64-decoded, BEFORE JSON parsing —
  // this must match what the write path hashed in verifyUserHcsTx.
  const raw = Buffer.from(m.message, "base64").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isValidEnvelope(parsed)) return null;
  return {
    stored: {
      seq: m.sequence_number,
      topic: topicId,
      consensusTimestamp: m.consensus_timestamp,
      contents: parsed,
    },
    raw,
  };
}

/**
 * Attach authorship attestations to decoded messages. Best-effort: a store
 * failure degrades to unattested messages (flagged, not hidden) rather
 * than failing the whole read.
 */
async function attachAttestations<T>(items: { stored: StoredMessage<T>; raw: string }[]): Promise<void> {
  if (items.length === 0) return;
  try {
    const hashes = items.map((i) => hashMessageContent(i.raw));
    const atts = await getAttestations(hashes);
    items.forEach((item, idx) => {
      const att = atts.get(hashes[idx]);
      // Leave the field UNSET (not null/undefined) when no attestation
      // exists — existing toEqual assertions on StoredMessage keep passing.
      if (att) item.stored.attestation = { payer: att.payer, author: att.author };
    });
  } catch (e) {
    console.warn(`[townhall] attestation enrichment failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export class RealHcsClient implements HcsPort {
  async verifyTx(
    txId: string,
    expectedTopicId: string,
    expectedPayer: string,
  ): Promise<VerifiedHcsTx | null> {
    return verifyHcsTransaction(txId, expectedTopicId, expectedPayer);
  }

  async query<T = TownhallMessage>(topicId: string, opts: QueryOpts = {}): Promise<StoredMessage<T>[]> {
    const limit = Math.min(opts.limit ?? 100, 100);
    const params = new URLSearchParams({ order: "asc", limit: String(limit) });
    if (opts.afterSeq !== undefined) params.set("sequencenumber", `gt:${opts.afterSeq}`);
    const url = `${mirrorBaseUrl()}/api/v1/topics/${topicId}/messages?${params}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Mirror node query failed (${res.status}) for topic ${topicId}`);
    }
    const data = (await res.json()) as MirrorMessagesResponse;
    const decoded: { stored: StoredMessage<T>; raw: string }[] = [];
    for (const m of data.messages ?? []) {
      const d = decodeMirrorMessage(topicId, m);
      if (d) decoded.push(d as { stored: StoredMessage<T>; raw: string });
    }
    await attachAttestations(decoded);
    return decoded.map((d) => d.stored);
  }

  async queryAll<T = TownhallMessage>(topicId: string, max = 2000): Promise<StoredMessage<T>[]> {
    const all: StoredMessage<T>[] = [];
    let after: number | undefined;
    while (all.length < max) {
      const page = await this.query<T>(topicId, { afterSeq: after, limit: 100 });
      if (page.length === 0) break;
      all.push(...page);
      after = page[page.length - 1].seq;
      if (page.length < 100) break;
    }
    return all.slice(0, max);
  }
}

/** In-memory HcsPort for tests and local dev without a network. */
export class MemoryHcsClient implements HcsPort {
  private store = new Map<string, { stored: StoredMessage; raw: string }[]>();
  private verifiedTxs = new Map<string, VerifiedHcsTx>();
  private attestations = new Map<string, Attestation>();

  async verifyTx(
    txId: string,
    expectedTopicId: string,
    expectedPayer: string,
  ): Promise<VerifiedHcsTx | null> {
    // In tests, txIds are synthetic. Accept any txId that was previously
    // "submitted" via the test helper, or any well-formed txId.
    const key = `${txId}:${expectedTopicId}:${expectedPayer}`;
    if (this.verifiedTxs.has(key)) {
      return this.verifiedTxs.get(key)!;
    }
    // Accept well-formed txIds for the expected payer (test convenience).
    // For content-bound verification, return an empty message — tests that
    // need content matching should use __verifyTx with a message.
    if (/^0\.0\.\d+[@-]\d+[.-]\d+$/.test(txId)) {
      const verified: VerifiedHcsTx = {
        topicId: expectedTopicId,
        payer: expectedPayer,
        message: "{}",
        sequenceNumber: 0,
      };
      this.verifiedTxs.set(key, verified);
      return verified;
    }
    return null;
  }

  /** Test helper: pre-register a verified tx with optional message content. */
  __verifyTx(txId: string, topicId: string, payer: string, message?: object): void {
    this.verifiedTxs.set(`${txId}:${topicId}:${payer}`, {
      topicId,
      payer,
      message: message ? JSON.stringify(message) : "{}",
      sequenceNumber: 0,
    });
  }

  /**
   * Test helper: record an authorship attestation for a message hash,
   * simulating the API write path. Compute the hash with
   * `hashMessageContent(JSON.stringify(message))` using the same object
   * passed to `seed()`.
   */
  __attest(hash: string, att: Omit<Attestation, "at">): void {
    this.attestations.set(hash, { ...att, at: Date.now() });
  }

  /** Attach attestations the same way RealHcsClient does (field left unset when absent). */
  private enrich(list: { stored: StoredMessage; raw: string }[]): StoredMessage[] {
    return list.map((m) => {
      const att = this.attestations.get(hashMessageContent(m.raw));
      if (!att) return m.stored;
      return { ...m.stored, attestation: { payer: att.payer, author: att.author } };
    });
  }

  async query<T = TownhallMessage>(topicId: string, opts: QueryOpts = {}): Promise<StoredMessage<T>[]> {
    const list = this.store.get(topicId) ?? [];
    const after = opts.afterSeq ?? 0;
    const page = list.filter((m) => m.stored.seq > after).slice(0, opts.limit ?? 100);
    return this.enrich(page) as StoredMessage<T>[];
  }

  async queryAll<T = TownhallMessage>(topicId: string, max = 2000): Promise<StoredMessage<T>[]> {
    const list = (this.store.get(topicId) ?? []).slice(0, max);
    return this.enrich(list) as StoredMessage<T>[];
  }

  /** Seed a raw message (tests). */
  seed(topicId: string, message: object): number {
    const list = this.store.get(topicId) ?? [];
    const seq = list.length + 1;
    list.push({
      stored: {
        seq,
        topic: topicId,
        consensusTimestamp: new Date().toISOString(),
        contents: message as TownhallMessage,
      },
      // The raw form a real client would have submitted: canonical
      // JSON serialization. Tests hashing this object get the same hash.
      raw: JSON.stringify(message),
    });
    this.store.set(topicId, list);
    return seq;
  }
}

let singleton: HcsPort | null = null;

/** Options for the CachedHcsClient wrapper (tests tune the TTLs down). */
export interface CachedHcsClientOpts {
  /** TTL for single-page query() results. Default 15s. */
  queryTtlSeconds?: number;
  /** TTL for queryAll() history results. Default 30s. */
  queryAllTtlSeconds?: number;
}

/**
 * Read-through caching wrapper around any HcsPort.
 *
 * `query()` results are cached per (topic, afterSeq, limit) for a short TTL
 * (chat/stream polls repeat the same query every few seconds), and
 * `queryAll()` history for a longer TTL.
 * All cache failures are fail-open: a missed/failed cache is just a plain
 * uncached call to the wrapped port.
 */
export class CachedHcsClient implements HcsPort {
  private readonly queryTtlSeconds: number;
  private readonly queryAllTtlSeconds: number;

  constructor(
    private readonly inner: HcsPort,
    private readonly cache: HcsCache = globalHcsCache(),
    opts: CachedHcsClientOpts = {},
  ) {
    this.queryTtlSeconds = opts.queryTtlSeconds ?? 15;
    this.queryAllTtlSeconds = opts.queryAllTtlSeconds ?? 30;
  }

  async verifyTx(
    txId: string,
    expectedTopicId: string,
    expectedPayer: string,
  ): Promise<VerifiedHcsTx | null> {
    // Verification is not cached — each tx is verified fresh.
    return this.inner.verifyTx(txId, expectedTopicId, expectedPayer);
  }

  async query<T = TownhallMessage>(topicId: string, opts: QueryOpts = {}): Promise<StoredMessage<T>[]> {
    // Clamp before building the key so it matches RealHcsClient's behavior.
    const limit = Math.min(opts.limit ?? 100, 100);
    const after = opts.afterSeq ?? 0;
    const key = `${topicId}:${after}:${limit}`;
    const hit = await this.cache.get<StoredMessage<T>[]>(key);
    if (hit !== null) {
      console.debug(`[hcs-cache] query hit ${key}`);
      return hit;
    }
    console.debug(`[hcs-cache] query miss ${key}`);
    const res = await this.inner.query<T>(topicId, { ...opts, limit });
    await this.cache.set(key, res, this.queryTtlSeconds);
    return res;
  }

  async queryAll<T = TownhallMessage>(topicId: string, max = 2000): Promise<StoredMessage<T>[]> {
    const key = `${topicId}:all:${max}`;
    const hit = await this.cache.get<StoredMessage<T>[]>(key);
    if (hit !== null) {
      console.debug(`[hcs-cache] queryAll hit ${key}`);
      return hit;
    }
    console.debug(`[hcs-cache] queryAll miss ${key}`);
    const res = await this.inner.queryAll<T>(topicId, max);
    await this.cache.set(key, res, this.queryAllTtlSeconds);
    return res;
  }
}

/** Default port used by the API routes (cached real HCS client). */
export function defaultHcsPort(): HcsPort {
  if (!singleton) singleton = new CachedHcsClient(new RealHcsClient());
  return singleton;
}
