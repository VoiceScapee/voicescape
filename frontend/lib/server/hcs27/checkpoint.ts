/**
 * HCS-27 transparency log checkpoints for Voicescape.
 *
 * Publishes Merkle-root checkpoints of our audit log (agent reviews, etc.)
 * to an HCS topic. Only the root goes on-chain; raw entries stay off-ledger.
 * Anyone can verify an entry was included via the Merkle proof.
 *
 * Checkpoint message format (from @hashgraphonline/standards-sdk):
 * {
 *   "p": "hcs-27",
 *   "op": "register",
 *   "metadata": {
 *     "type": "voicescape-audit-v1",
 *     "stream": { "registry": "voicescape", "log_id": "<log-id>" },
 *     "log": { "alg": "sha-256", "leaf": "sha256(jcs(event))", "merkle": "rfc9162" },
 *     "root": { "treeSize": "<n>", "rootHashB64u": "<base64url>" },
 *     "prev": { "treeSize": "<n>", "rootHashB64u": "<base64url>" } | null,
 *     "sig": null
 *   }
 * }
 *
 * Note: upstream hardcodes type='ans-checkpoint-v1'. We use our own type
 * until the standard accepts custom types.
 */
import {
  merkleRootFromEntries,
  toBase64Url,
  emptyHCS27Root,
} from "./merkle";

export const HCS27_PROTOCOL = "hcs-27";
export const VOICESCAPE_AUDIT_TYPE = "voicescape-audit-v1";

/**
 * Voicescape HCS-27 transparency log topic (mainnet).
 * Created 2026-10-06. Memo: hcs-27:0:86400:0
 * Verify: https://hashscan.io/mainnet/topic/0.0.10908357
 */
export const VOICESCAPE_HCS27_TOPIC = "0.0.10908357";

/** Topic memo for HCS-27 checkpoint topics. */
export function hcs27TopicMemo(ttlSeconds: number = 86400): string {
  return `hcs-27:0:${ttlSeconds}:0`;
}

export interface HCS27Checkpoint {
  p: "hcs-27";
  op: "register";
  metadata: {
    type: string;
    stream: { registry: string; log_id: string };
    log: { alg: string; leaf: string; merkle: string };
    root: { treeSize: string; rootHashB64u: string };
    prev: { treeSize: string; rootHashB64u: string } | null;
    sig: null;
  };
  m?: string;
}

/**
 * Build a checkpoint message for a batch of audit entries.
 *
 * @param logId - which log this checkpoint covers (e.g. 'agent-reviews')
 * @param entries - the audit entries (will be canonicalized + hashed)
 * @param prev - previous checkpoint root, if any (for consistency chain)
 * @param memo - optional memo (max 299 chars)
 */
export function buildCheckpoint(
  logId: string,
  entries: ReadonlyArray<unknown>,
  prev: { treeSize: string; rootHashB64u: string } | null = null,
  memo?: string,
): HCS27Checkpoint {
  const root =
    entries.length === 0
      ? emptyHCS27Root()
      : merkleRootFromEntries(entries);

  const msg: HCS27Checkpoint = {
    p: HCS27_PROTOCOL,
    op: "register",
    metadata: {
      type: VOICESCAPE_AUDIT_TYPE,
      stream: { registry: "voicescape", log_id: logId },
      log: { alg: "sha-256", leaf: "sha256(jcs(event))", merkle: "rfc9162" },
      root: {
        treeSize: String(entries.length),
        rootHashB64u: toBase64Url(root),
      },
      prev,
      sig: null,
    },
  };
  if (memo) {
    msg.m = memo.slice(0, 299);
  }
  return msg;
}

/** Serialize a checkpoint for HCS topic submission. */
export function serializeCheckpoint(cp: HCS27Checkpoint): string {
  return JSON.stringify(cp);
}
