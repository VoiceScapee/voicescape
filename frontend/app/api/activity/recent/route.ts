import { NextResponse } from "next/server";

/**
 * GET /api/activity/recent
 *
 * Returns recent on-chain tips from the VoicescapeTips contract.
 * Queries Hedera Mirror Node for TipSent event logs, newest first.
 * Only verified TipSent events are returned (not marketplace purchases).
 *
 * Response: { tips: [{ txHash, from, to, amountHbar, timestamp }] }
 */

// TipSent(string,address,address,uint256,uint256) event signature
const TIPSENT_TOPIC = "0xddb557901a5c7e767f2276c1190ca61ae148d62a74cfa61e4f7fa5319eaa431e";

// VoicescapeTips contract
const CONTRACT_ID = "0.0.10854060";

export async function GET() {
  try {
    // Query Mirror Node for contract logs (includes event data)
    const url = `https://mainnet.mirrornode.hedera.com/api/v1/contracts/${CONTRACT_ID}/results/logs?order=desc&limit=20`;

    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      next: { revalidate: 60 }, // Cache for 60 seconds
    });

    if (!res.ok) {
      return NextResponse.json({ tips: [], error: "Mirror Node unavailable" });
    }

    const data = await res.json();
    const logs = data.logs || [];

    const tips = [];
    for (const log of logs) {
      // Only TipSent events (filters out PurchaseCompleted and others)
      if (!log.topics || log.topics[0]?.toLowerCase() !== TIPSENT_TOPIC) continue;

      // Topics: [signature, usernameHash, from, toOwner]
      // Data: amount (uint256), fee (uint256)
      const from = log.topics[2] ? "0x" + log.topics[2].slice(-40) : null;
      const toOwner = log.topics[3] ? "0x" + log.topics[3].slice(-40) : null;

      // Decode amount from data (first 32 bytes)
      let amountHbar = "0";
      if (log.data && log.data.length >= 66) {
        try {
          const amountWei = BigInt("0x" + log.data.slice(2, 66));
          amountHbar = (Number(amountWei) / 100_000_000).toFixed(4);
        } catch {
          continue;
        }
      }

      if (!from || !toOwner) continue;

      // Get the Hedera transaction ID for HashScan links
      // (HashScan URLs need 0.0.x-timestamp-nonce format, not the 0x hash)
      let txId = log.transaction_hash; // fallback
      try {
        const txRes = await fetch(
          `https://mainnet.mirrornode.hedera.com/api/v1/transactions?timestamp=${log.timestamp}`,
          { headers: { "Accept": "application/json" } }
        );
        if (txRes.ok) {
          const txData = await txRes.json();
          const tx = txData.transactions?.[0];
          if (tx?.transaction_id) txId = tx.transaction_id;
        }
      } catch {
        // Use hash as fallback
      }

      tips.push({
        txHash: txId,
        from,
        to: toOwner,
        amountHbar,
        timestamp: log.timestamp,
      });

      if (tips.length >= 5) break;
    }

    return NextResponse.json({ tips });
  } catch (err) {
    console.error("[activity] Error fetching recent activity:", err);
    return NextResponse.json({ tips: [], error: "Failed to fetch activity" });
  }
}
