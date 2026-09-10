/**
 * Voicescape Social Town Hall — HCS submit + query.
 *
 * Submit goes through @hashgraph/sdk with the server operator
 * (TOWNHALL_OPERATOR_ID / TOWNHALL_OPERATOR_KEY — server-only, never in the
 * browser). Reads go through the free mirror node REST API.
 *
 * The `HcsPort` interface is the seam tests mock; the real client is
 * `RealHcsClient` via `defaultHcsPort()`.
 */

import {
  Client,
  PrivateKey,
  TopicId,
  TopicMessageSubmitTransaction,
} from "@hashgraph/sdk";
import { mirrorBaseUrl, townhallNetwork } from "./topics";
import type { StoredMessage, TownhallMessage } from "./types";
import { globalHcsCache, type HcsCache } from "./hcs-cache";

export interface QueryOpts {
  /** Only messages with seq greater than this. */
  afterSeq?: number;
  /** Per-request page size (mirror node max 100). */
  limit?: number;
}

export interface HcsPort {
  /** Submit a message; resolves to the consensus sequence number. */
  submit(topicId: string, message: object): Promise<number>;
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

function hcsClient(): Client {
  const operatorId = process.env.TOWNHALL_OPERATOR_ID;
  const operatorKey = process.env.TOWNHALL_OPERATOR_KEY;
  if (!operatorId || !operatorKey) {
    throw new Error(
      "TOWNHALL_OPERATOR_ID / TOWNHALL_OPERATOR_KEY are not set — the Town Hall server cannot submit HCS messages.",
    );
  }
  const network = townhallNetwork();
  const client =
    network === "mainnet"
      ? Client.forMainnet()
      : network === "previewnet"
        ? Client.forPreviewnet()
        : Client.forTestnet();
  client.setOperator(operatorId, PrivateKey.fromString(operatorKey));
  return client;
}

export function isValidEnvelope(raw: unknown): raw is TownhallMessage {
  if (typeof raw !== "object" || raw === null) return false;
  const m = raw as Record<string, unknown>;
  return m.v === 1 && typeof m.kind === "string" && typeof m.author === "string" && typeof m.ts === "string";
}

function decodeMirrorMessage(topicId: string, m: MirrorMessage): StoredMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(m.message, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!isValidEnvelope(parsed)) return null;
  return {
    seq: m.sequence_number,
    topic: topicId,
    consensusTimestamp: m.consensus_timestamp,
    contents: parsed,
  };
}

export class RealHcsClient implements HcsPort {
  async submit(topicId: string, message: object): Promise<number> {
    const client = hcsClient();
    try {
      const tx = await new TopicMessageSubmitTransaction()
        .setTopicId(TopicId.fromString(topicId))
        .setMessage(JSON.stringify(message))
        .execute(client);
      const receipt = await tx.getReceipt(client);
      return Number(receipt.topicSequenceNumber ?? 0);
    } finally {
      client.close();
    }
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
    const out: StoredMessage<T>[] = [];
    for (const m of data.messages ?? []) {
      const decoded = decodeMirrorMessage(topicId, m);
      if (decoded) out.push(decoded as StoredMessage<T>);
    }
    return out;
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
  private store = new Map<string, StoredMessage[]>();

  async submit(topicId: string, message: object): Promise<number> {
    const list = this.store.get(topicId) ?? [];
    const seq = list.length + 1;
    list.push({
      seq,
      topic: topicId,
      consensusTimestamp: new Date().toISOString(),
      contents: message as TownhallMessage,
    });
    this.store.set(topicId, list);
    return seq;
  }

  async query<T = TownhallMessage>(topicId: string, opts: QueryOpts = {}): Promise<StoredMessage<T>[]> {
    const list = (this.store.get(topicId) ?? []) as StoredMessage<T>[];
    const after = opts.afterSeq ?? 0;
    return list.filter((m) => m.seq > after).slice(0, opts.limit ?? 100);
  }

  async queryAll<T = TownhallMessage>(topicId: string, max = 2000): Promise<StoredMessage<T>[]> {
    return ((this.store.get(topicId) ?? []) as StoredMessage<T>[]).slice(0, max);
  }

  /** Seed a raw message (tests). */
  seed(topicId: string, message: object): number {
    const list = this.store.get(topicId) ?? [];
    const seq = list.length + 1;
    list.push({
      seq,
      topic: topicId,
      consensusTimestamp: new Date().toISOString(),
      contents: message as TownhallMessage,
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
 * `queryAll()` history for a longer TTL. `submit()` invalidates the whole
 * topic's cache, so a write is immediately visible to subsequent reads.
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

  async submit(topicId: string, message: object): Promise<number> {
    const seq = await this.inner.submit(topicId, message);
    await this.cache.invalidateTopic(topicId);
    return seq;
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
