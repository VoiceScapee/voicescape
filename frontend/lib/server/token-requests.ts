/**
 * token-requests — link-based capability-token issuance for keyless agents
 * whose human lives outside the dapp.
 *
 * The agent calls the `request_capability_token` MCP tool and gets an
 * issuance URL (/t/<id>) to drop in its OWN chat. The human opens it,
 * connects their wallet, and taps "Issue pass" — the wallet pairing IS the
 * consent, and the token is bound to the paired account. The raw token is
 * shown ONCE on the page; the human puts it in the agent's secure
 * credential storage (never in chat).
 *
 * Security model (mirrors the claim-link pattern):
 * - Auth is the unguessable request id (32 hex chars) + the human's wallet
 *   pairing. The output is a token bound to the paired account — useless
 *   to anyone whose account doesn't own pages the agent targets.
 * - Requests are one-time: issuing consumes the request.
 * - Requests expire after 24h, like claim packages and proposals.
 * - The token itself keeps all capability-token properties (hash-only
 *   storage, 30-day expiry, instant revocation, propose-only scopes).
 */
import { randomBytes } from "node:crypto";
import { getKvStore, type KvStore } from "./store";
import {
  CAPABILITY_SCOPES,
  DEFAULT_CAPABILITY_SCOPES,
  type CapabilityScope,
} from "./capability-tokens";

const KEY_PREFIX = "cap-token-requests:";
const TTL_MS = 24 * 3_600_000;

export interface TokenRequest {
  id: string;
  /** Agent-chosen label, shown to the human — e.g. "muse AI agent". */
  label: string;
  scopes: CapabilityScope[];
  createdAt: number;
}

function keyFor(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

function isScope(s: unknown): s is CapabilityScope {
  return typeof s === "string" && (CAPABILITY_SCOPES as readonly string[]).includes(s);
}

export interface CreateTokenRequestInput {
  label: string;
  scopes?: CapabilityScope[];
}

/** Create an issuance request. Returns the record (id is the /t/<id> path). */
export async function createTokenRequest(
  input: CreateTokenRequestInput,
  store: KvStore = getKvStore(),
): Promise<TokenRequest> {
  const label = (input.label ?? "").trim().slice(0, 80);
  if (!label) throw new Error("createTokenRequest: label is required");
  const scopes = input.scopes ?? [...DEFAULT_CAPABILITY_SCOPES];
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(isScope)) {
    throw new Error("createTokenRequest: scopes must be a non-empty subset of the known scopes");
  }
  const record: TokenRequest = {
    id: randomBytes(16).toString("hex"),
    label,
    scopes: [...new Set(scopes)],
    createdAt: Date.now(),
  };
  await store.set(keyFor(record.id), JSON.stringify(record), TTL_MS);
  return record;
}

/** Read a request by id, or null when unknown/malformed/expired. */
export async function getTokenRequest(
  id: string,
  store: KvStore = getKvStore(),
): Promise<TokenRequest | null> {
  const clean = (id ?? "").trim();
  if (!/^[0-9a-f]{32}$/.test(clean)) return null;
  const raw = await store.get(keyFor(clean));
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as TokenRequest;
    if (!rec || rec.id !== clean || typeof rec.label !== "string") return null;
    if (!Array.isArray(rec.scopes) || !rec.scopes.every(isScope)) return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * Consume a request for issuance: returns the record and deletes it so the
 * link is one-time. Returns null when unknown/malformed/expired.
 */
export async function consumeTokenRequest(
  id: string,
  store: KvStore = getKvStore(),
): Promise<TokenRequest | null> {
  const rec = await getTokenRequest(id, store);
  if (!rec) return null;
  await store.del(keyFor(rec.id));
  return rec;
}
