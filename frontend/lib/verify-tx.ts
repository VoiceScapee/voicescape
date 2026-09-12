/**
 * On-chain verification helpers for contract writes.
 *
 * Both the tip flow and the marketplace purchase flow need to confirm that
 * a wallet-submitted transaction actually succeeded on-chain before claiming
 * success to the user. The wallet receipt only proves submission, not success.
 *
 * Uses the Hedera mainnet Mirror Node contract-results endpoint, which
 * accepts both SDK-format transaction IDs (0.0.x-...) and EVM transaction
 * hashes (0x...).
 */

const MIRROR_NODE = "https://mainnet.mirrornode.hedera.com/api/v1";

// TipSent(string,address,address,uint256,uint256)
const TIPSENT_TOPIC = "0xddb557901a5c7e767f2276c1190ca61ae148d62a74cfa61e4f7fa5319eaa431e";
// PurchaseCompleted(address,address,string,uint256,uint256)
const PURCHASE_COMPLETED_TOPIC = "0x8555727c6813e10ae0b5a9b0a53a88a93176679845f5a005a248cdb9f1c05f2e";

export type VerificationResult =
  | { status: "confirmed" }
  | { status: "failed" }
  | { status: "unknown" }; // submitted but not yet visible (mirror lag, timeout)

interface ContractResult {
  status?: string;
  amount?: string;
  logs?: Array<{ topics?: string[] }>;
  results?: ContractResult[];
}

/**
 * Poll the mirror node until the transaction is confirmed on-chain with
 * the expected event, fails on-chain, or times out.
 *
 * @param txIdOrHash SDK-format tx ID (0.0.x-...) or EVM tx hash (0x...)
 * @param expectedTopic topic0 of the event to look for (TipSent or PurchaseCompleted)
 * @param attempts number of poll attempts (default 12)
 * @param intervalMs ms between attempts (default 2500)
 */
export async function verifyContractResult(
  txIdOrHash: string,
  expectedTopic: "tip" | "purchase",
  attempts = 12,
  intervalMs = 2500,
): Promise<VerificationResult> {
  const topic = expectedTopic === "tip" ? TIPSENT_TOPIC : PURCHASE_COMPLETED_TOPIC;
  const url = `${MIRROR_NODE}/contracts/results/${txIdOrHash}`;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as ContractResult;
        const r = data.results?.[0] ?? data;
        const amount = BigInt(r.amount ?? "0");
        const logs = r.logs ?? [];
        const hasEvent = logs.some((log) =>
          (log.topics ?? []).some((t) => t.toLowerCase() === topic.toLowerCase()),
        );
        if (r.status === "0x1" && amount > 0n && hasEvent) {
          return { status: "confirmed" };
        }
        // Result exists but the transaction failed on-chain — stop polling.
        if (r.status && r.status !== "0x1") {
          return { status: "failed" };
        }
        // Result exists but no event yet — keep polling (mirror lag).
      }
    } catch {
      // Network error — retry.
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  // Never saw a confirmed result. The transaction was submitted to the
  // wallet successfully, but we can't prove on-chain success yet. Callers
  // must show an honest "submitted — check explorer" state, NOT "failed".
  return { status: "unknown" };
}

/** Verify a tip transaction on-chain. */
export function verifyTipOnChain(
  txIdOrHash: string,
  attempts = 12,
  intervalMs = 2500,
): Promise<VerificationResult> {
  return verifyContractResult(txIdOrHash, "tip", attempts, intervalMs);
}

/** Verify a marketplace purchase transaction on-chain. */
export function verifyPurchaseOnChain(
  txIdOrHash: string,
  attempts = 12,
  intervalMs = 2500,
): Promise<VerificationResult> {
  return verifyContractResult(txIdOrHash, "purchase", attempts, intervalMs);
}
