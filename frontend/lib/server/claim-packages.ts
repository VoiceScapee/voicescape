/**
 * claim-packages — KV-backed store for agent claim packages behind short
 * approval links (/c/<id>).
 *
 * The agent's MCP call (prepare_agent_claim) stashes a package here instead
 * of handing the human kilobytes of base64 JSON: the human gets a short
 * URL they open in any browser. The package carries everything needed to
 * finish the claim at tap time — nothing is baked until the wallet pairs:
 * the starter page is pinned to IPFS and the registerPage transaction is
 * built by POST /api/claim-packages/[id]/finalize with the ACTUALLY
 * CONNECTED account as payer. Whoever pairs owns it — the human never
 * types an account id.
 *
 * Never stores keys, never signs. The id is 128 bits of randomness; the
 * link is the capability. 24h TTL — an untapped package simply expires.
 */
import { randomBytes } from "node:crypto";
import { getKvStore, type KvStore } from "./store";

export interface ClaimPackageInput {
  username: string;
  purpose: string;
  displayName?: string;
  capabilities?: string[];
  /** Explicit 0x operator override, or null (defaults to the payer's address). */
  operator?: string | null;
  /** Intro claim code from post_agent_intro, for auto-linking after registration. */
  claimCode?: string | null;
  /** Optional owner override; null = the wallet that taps approve owns it. */
  ownerAccountId?: string | null;
  pageUrl: string;
}

export interface ClaimPackageRecord extends ClaimPackageInput {
  id: string;
  createdAt: number;
  /** Starter-page CID — pinned at finalize time, not prepare time. */
  cid: string | null;
}

const KEY_PREFIX = "claim-package:";
const TTL_MS = 24 * 3_600_000;
const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;

function keyFor(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

function validId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id);
}

/**
 * Stash a new claim package under a fresh short id. Throws on invalid
 * input. `store` is injectable for tests.
 */
export async function stashClaimPackage(
  input: ClaimPackageInput,
  store: KvStore = getKvStore(),
): Promise<ClaimPackageRecord> {
  const username = input.username.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw new Error("stashClaimPackage: bad username");
  const purpose = input.purpose.trim();
  if (!purpose || purpose.length > 500) throw new Error("stashClaimPackage: bad purpose");
  const ownerAccountId = input.ownerAccountId ?? null;
  if (ownerAccountId !== null && !/^0\.0\.\d+$/.test(ownerAccountId.trim())) {
    throw new Error("stashClaimPackage: bad owner account id");
  }
  const operator = input.operator ?? null;
  if (operator !== null && !/^0x[0-9a-fA-F]{40}$/.test(operator.trim())) {
    throw new Error("stashClaimPackage: bad operator");
  }
  const claimCode = input.claimCode ?? null;
  if (claimCode !== null && !/^[A-Z0-9-]{4,16}$/.test(claimCode.trim())) {
    throw new Error("stashClaimPackage: bad claim code");
  }
  const record: ClaimPackageRecord = {
    username,
    purpose,
    displayName: (input.displayName ?? "").trim().slice(0, 60) || username,
    capabilities: (input.capabilities ?? [])
      .filter((c) => typeof c === "string" && c.trim() !== "")
      .map((c) => c.trim().slice(0, 40))
      .slice(0, 20),
    operator: operator ? operator.trim().toLowerCase() : null,
    claimCode: claimCode ? claimCode.trim().toUpperCase() : null,
    ownerAccountId: ownerAccountId ? ownerAccountId.trim() : null,
    pageUrl: input.pageUrl,
    id: randomBytes(16).toString("hex"),
    createdAt: Date.now(),
    cid: null,
  };
  await store.set(keyFor(record.id), JSON.stringify(record), TTL_MS);
  return record;
}

/** The claim package for a short id, or null when unknown/expired. */
export async function getClaimPackage(
  id: string,
  store: KvStore = getKvStore(),
): Promise<ClaimPackageRecord | null> {
  if (!validId(id)) return null;
  const raw = await store.get(keyFor(id));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as ClaimPackageRecord;
    if (!p || p.id !== id || typeof p.username !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

/** Persist an updated record (e.g. after pinning the starter page). */
export async function saveClaimPackage(
  record: ClaimPackageRecord,
  store: KvStore = getKvStore(),
): Promise<void> {
  if (!validId(record.id)) throw new Error("saveClaimPackage: bad id");
  await store.set(keyFor(record.id), JSON.stringify(record), TTL_MS);
}

/** Delete a package — after a completed claim, or explicit invalidation. */
export async function deleteClaimPackage(
  id: string,
  store: KvStore = getKvStore(),
): Promise<void> {
  if (!validId(id)) return;
  await store.del(keyFor(id));
}
