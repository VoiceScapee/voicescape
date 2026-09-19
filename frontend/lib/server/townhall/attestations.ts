/**
 * Voicescape Social Town Hall — authorship attestations.
 *
 * Audit finding #1 (HIGH): the town-hall HCS topics are open, so anyone can
 * submit a message directly to a topic claiming any `author`. The read path
 * used to trust the content `author`/`voter` fields with no payer binding.
 *
 * The write path (`verifyUserHcsTx`) already verifies via the mirror node
 * that the tx payer == the session wallet and that the wallet owns the
 * claimed username — but that knowledge was discarded. This module persists
 * it as an attestation: sha256(raw on-chain message bytes) →
 * { payer, author, topic, txId }. The read path (`RealHcsClient.query`)
 * re-hashes each message's exact bytes and attaches the attestation when
 * found; vote tallies only count attested votes, and views flag unverified
 * authors instead of hiding them.
 *
 * Tradeoff (deliberate): votes submitted before this fix are unattested
 * and stop counting — scores effectively reset. Correctness beats
 * continuity: a score that can be forged is worse than no score.
 *
 * All store access is best-effort: attestation failures are logged and
 * never fail a write or a read.
 */

import { createHash } from "node:crypto";
import { getKvStore } from "../store";
import type { StoredMessage } from "./types";

export interface Attestation {
  /** Hedera account id (0.0.x) that paid for the HCS submit. */
  payer: string;
  /** On-chain `author` (registered username) the payer claimed. */
  author: string;
  /** Topic id the message was submitted to. */
  topic: string;
  /** The HCS transaction id that carried the message. */
  txId: string;
  /** Unix ms when the attestation was recorded. */
  at: number;
}

/** Attestations live a year — long enough for any realistic read window. */
const ATTESTATION_TTL_MS = 365 * 24 * 3600 * 1000;

function attestKey(hash: string): string {
  return `vs:attest:${hash}`;
}

/** sha256 hex of the UTF-8 bytes of the raw on-chain message string. */
export function hashMessageContent(rawMessage: string): string {
  return createHash("sha256").update(rawMessage, "utf8").digest("hex");
}

/**
 * Record an authorship attestation. Best-effort: logs and returns on
 * failure, never throws — an attestation must never fail a write.
 */
export async function recordAttestation(
  hash: string,
  att: Omit<Attestation, "at">,
): Promise<void> {
  try {
    await getKvStore().set(
      attestKey(hash),
      JSON.stringify({ ...att, at: Date.now() }),
      ATTESTATION_TTL_MS,
    );
  } catch (e) {
    console.warn(`[townhall] attestation record failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Fetch one attestation by message hash. Null when absent or corrupt. */
export async function getAttestation(hash: string): Promise<Attestation | null> {
  let raw: string | null;
  try {
    raw = await getKvStore().get(attestKey(hash));
  } catch (e) {
    console.warn(`[townhall] attestation read failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Attestation>;
    if (
      typeof parsed.payer !== "string" ||
      typeof parsed.author !== "string" ||
      typeof parsed.topic !== "string" ||
      typeof parsed.txId !== "string"
    ) {
      return null;
    }
    return parsed as Attestation;
  } catch {
    return null;
  }
}

/** Batch-fetch attestations (the kv store has no mget — Promise.all of gets). */
export async function getAttestations(hashes: string[]): Promise<Map<string, Attestation>> {
  const out = new Map<string, Attestation>();
  const results = await Promise.all(hashes.map((h) => getAttestation(h)));
  hashes.forEach((h, i) => {
    const att = results[i];
    if (att) out.set(h, att);
  });
  return out;
}

/** Test-only: empty the attestation registry. */
export async function clearAttestations(): Promise<void> {
  await getKvStore().clearPrefix("vs:attest:");
}

/**
 * The security core for every vote-counting surface: a vote counts only
 * when its on-chain bytes carry an attestation whose author matches the
 * claimed voter. Spoofed votes (direct-to-topic, forged `voter`) have no
 * attestation — or an attestation for a different author — and are skipped.
 */
export function isAttestedVote(
  msg: Pick<StoredMessage, "attestation">,
  claimedVoter: string,
): boolean {
  const att = msg.attestation;
  return !!att && att.author.toLowerCase() === claimedVoter.toLowerCase();
}

/**
 * Display-surface rule: the shown author is verified only when the
 * message's on-chain bytes carry an attestation for that same author.
 * Unverified ≠ hidden — views flag it, they don't drop the message.
 */
export function isAuthorVerified(msg: Pick<StoredMessage, "attestation" | "contents">): boolean {
  const att = msg.attestation;
  return !!att && att.author.toLowerCase() === msg.contents.author.toLowerCase();
}
