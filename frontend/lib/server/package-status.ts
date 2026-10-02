/**
 * package-status — terminal-state records for claim/vault packages.
 *
 * The packages themselves expire silently after 24h, which left the AGENT
 * blind: "did the human tap?", "did I lose the username race?", "was the
 * finalize replayed?". These status records answer those questions. They
 * live 7 days (longer than the 24h package TTL) so an agent polling after
 * expiry still learns what happened instead of guessing from a 404.
 *
 * Statuses:
 *   pending    — package created, awaiting the human tap
 *   finalized  — human tapped; unsigned tx issued (claim) / vault verified (vault)
 *   completed  — on-chain effect confirmed (vault watch registered; claim intro linked)
 *   race_lost  — username was taken before finalize; package is dead
 *   expired    — (written lazily on read) package gone without terminal state
 *
 * A 404 from the status endpoint means the id never existed.
 */
import { getKvStore, type KvStore } from "./store";

export type PackageStatusKind = "claim" | "vault";

export type PackageStatus =
  | "pending"
  | "finalized"
  | "completed"
  | "race_lost"
  | "expired";

export interface PackageStatusRecord {
  packageId: string;
  kind: PackageStatusKind;
  status: PackageStatus;
  updatedAt: number;
  /** Human/agent-readable detail, e.g. who took the username. */
  detail?: string;
  /** For finalized/completed: what was issued or created. */
  transactionId?: string;
  username?: string;
  vaultAccountId?: string;
}

const KEY_PREFIX = "package-status:";
const TTL_MS = 7 * 24 * 3_600_000; // 7 days — outlives the 24h package TTL
const ID_RE = /^[0-9a-f]{32}$/;

function keyFor(kind: PackageStatusKind, id: string): string {
  return `${KEY_PREFIX}${kind}:${id}`;
}

/** Write (or overwrite) the terminal status for a package. Never throws. */
export async function setPackageStatus(
  kind: PackageStatusKind,
  id: string,
  status: PackageStatus,
  extra: Partial<Pick<PackageStatusRecord, "detail" | "transactionId" | "username" | "vaultAccountId">> = {},
  store: KvStore = getKvStore(),
): Promise<void> {
  try {
    if (!ID_RE.test(id)) return;
    const record: PackageStatusRecord = {
      packageId: id,
      kind,
      status,
      updatedAt: Date.now(),
      ...extra,
    };
    await store.set(keyFor(kind, id), JSON.stringify(record), TTL_MS);
  } catch {
    /* status is observability — never break the caller */
  }
}

/**
 * Read the status record. Returns null when the id never existed.
 * When the id is well-formed but has no record, the caller should check
 * whether the package itself still exists (pending) — this function only
 * reports recorded terminal states.
 */
export async function getPackageStatus(
  kind: PackageStatusKind,
  id: string,
  store: KvStore = getKvStore(),
): Promise<PackageStatusRecord | null> {
  try {
    if (!ID_RE.test(id)) return null;
    const raw = await store.get(keyFor(kind, id));
    if (!raw) return null;
    const p = JSON.parse(raw) as PackageStatusRecord;
    if (!p || p.packageId !== id || p.kind !== kind) return null;
    return p;
  } catch {
    return null;
  }
}
