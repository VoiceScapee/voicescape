/**
 * HCS-27 checkpoint publisher for Voicescape.
 *
 * Submits built checkpoints to the HCS-27 transparency topic (0.0.10908357)
 * on Hedera mainnet. The topic has a submit key — only our operator key
 * can write to it.
 *
 * IMPORTANT: HCS-27 is a COMMUNITY DRAFT
 * (hiero-ledger/hiero-consensus-specifications, by Connor Snitker),
 * NOT an official Hedera standard. Never claim otherwise.
 *
 * Design:
 * - Fail-open: if HCS27_PUBLISHER_KEY is not configured, or publishing
 *   fails, the caller gets a { published: false, reason } result and
 *   continues. Checkpoint publishing never blocks the review flow.
 * - Prev linkage: reads the last checkpoint from the topic via the mirror
 *   node to chain checkpoints together (consistency proof).
 * - The publisher key is the ops wallet's key (0.0.10857765), which holds
 *   the topic's submit key. Set HCS27_PUBLISHER_KEY in Vercel env.
 *
 * Cost: each checkpoint is one HCS message submit (~$0.0001 in HBAR),
 * paid by the ops wallet, not by users.
 */
import {
  AccountId,
  Client,
  PrivateKey,
  TopicId,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import {
  buildCheckpoint,
  serializeCheckpoint,
  VOICESCAPE_HCS27_TOPIC,
  HCS27Checkpoint,
} from "./checkpoint";

/** Mirror node base for mainnet. */
const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";

/** Log ID for agent tipping reviews in the transparency log. */
export const REVIEWS_LOG_ID = "agent-reviews";

export interface PublisherDeps {
  /** Fetch function (injectable for tests). */
  fetchFn?: typeof fetch;
  /** Environment (injectable for tests). */
  env?: Record<string, string | undefined>;
  /** Execute a signed transaction; resolves the tx ID (injectable for tests). */
  executeTx?: (tx: TopicMessageSubmitTransaction) => Promise<string>;
}

export interface PublishResult {
  published: boolean;
  /** Transaction ID of the published checkpoint (when published). */
  txId?: string;
  /** Why publishing didn't happen (when not published). */
  reason?: string;
  /** The checkpoint that was (or would have been) published. */
  checkpoint?: HCS27Checkpoint;
}

/**
 * Read the last checkpoint from the HCS-27 topic via the mirror node.
 * Returns the root { treeSize, rootHashB64u } for prev-linkage, or null
 * if no checkpoints exist yet or the read fails.
 */
export async function getLastCheckpointRoot(
  deps: PublisherDeps = {},
): Promise<{ treeSize: string; rootHashB64u: string } | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const url =
      `${MIRROR_BASE}/topics/${VOICESCAPE_HCS27_TOPIC}/messages` +
      `?limit=1&order=desc`;
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      messages?: Array<{ message?: string }>;
    };
    const msg = data.messages?.[0]?.message;
    if (!msg) return null;
    // Mirror node returns base64-encoded message bytes.
    const decoded = Buffer.from(msg, "base64").toString("utf8");
    const cp = JSON.parse(decoded) as HCS27Checkpoint;
    if (cp.p !== "hcs-27" || !cp.metadata?.root) return null;
    return {
      treeSize: cp.metadata.root.treeSize,
      rootHashB64u: cp.metadata.root.rootHashB64u,
    };
  } catch {
    return null;
  }
}

/**
 * Publish a checkpoint to the HCS-27 topic.
 *
 * @param checkpoint - the built checkpoint to publish
 * @param deps - injectable dependencies (fetch, env, tx executor)
 */
export async function publishCheckpoint(
  checkpoint: HCS27Checkpoint,
  deps: PublisherDeps = {},
): Promise<PublishResult> {
  const env = deps.env ?? process.env;
  const keyStr = env.HCS27_PUBLISHER_KEY;
  if (!keyStr) {
    return {
      published: false,
      reason: "HCS27_PUBLISHER_KEY not configured",
      checkpoint,
    };
  }

  try {
    const message = serializeCheckpoint(checkpoint);
    const tx = new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(VOICESCAPE_HCS27_TOPIC))
      .setMessage(message);

    let txId: string;
    if (deps.executeTx) {
      txId = await deps.executeTx(tx);
    } else {
      const privateKey = PrivateKey.fromString(keyStr);
      const client = Client.forMainnet().setOperator(
        AccountId.fromString("0.0.10857765"),
        privateKey,
      );
      const txResponse = await tx.execute(client);
      const receipt = await txResponse.getReceipt(client);
      txId = txResponse.transactionId.toString();
      client.close();
      void receipt;
    }

    return { published: true, txId, checkpoint };
  } catch (err) {
    return {
      published: false,
      reason: err instanceof Error ? err.message : "unknown publish error",
      checkpoint,
    };
  }
}

/**
 * Build and publish a checkpoint for a batch of review entries.
 * Reads the previous checkpoint for chaining, builds the new checkpoint,
 * and publishes it. Fail-open: never throws.
 *
 * @param logId - which log (e.g. 'agent-reviews')
 * @param entries - the audit entries to include
 * @param deps - injectable dependencies
 */
export async function publishReviewCheckpoint(
  logId: string,
  entries: ReadonlyArray<unknown>,
  deps: PublisherDeps = {},
): Promise<PublishResult> {
  const prev = await getLastCheckpointRoot(deps);
  const checkpoint = buildCheckpoint(logId, entries, prev);
  return publishCheckpoint(checkpoint, deps);
}
