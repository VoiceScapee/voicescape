import { NextResponse } from "next/server";

/**
 * GET /api/notifications?address=0x...
 *
 * Returns recent tip notifications for a wallet address.
 * Queries Hedera Mirror Node for TipSent events where the
 * recipient (toOwner) matches the given address.
 *
 * Response: { notifications: [{ txId, from, amountHbar, timestamp }] }
 */

const TIPSENT_TOPIC = "0xddb557901a5c7e767f2276c1190ca61ae148d62a74cfa61e4f7fa5319eaa431e";
const CONTRACT_ID = "0.0.10854060";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const address = searchParams.get("address")?.toLowerCase();

    if (!address || !/^0x[0-9a-f]{40}$/.test(address)) {
      return NextResponse.json({ notifications: [], error: "Invalid address" });
    }

    // Pad address to 32-byte topic format
    const topicAddress = "0x" + address.slice(2).padStart(64, "0");

    // Query logs where topic3 (toOwner) matches the address
    const url =
      `https://mainnet.mirrornode.hedera.com/api/v1/contracts/${CONTRACT_ID}/results/logs` +
      `?order=desc&limit=20&topic3=${topicAddress}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      return NextResponse.json({ notifications: [], error: "Mirror Node unavailable" });
    }

    const data = await res.json();
    const logs = data.logs || [];

    const notifications = [];
    for (const log of logs) {
      if (log.topics?.[0]?.toLowerCase() !== TIPSENT_TOPIC) continue;

      const from = log.topics[2] ? "0x" + log.topics[2].slice(-40) : null;
      if (!from) continue;

      let amountHbar = "0";
      if (log.data && log.data.length >= 66) {
        try {
          const amountWei = BigInt("0x" + log.data.slice(2, 66));
          amountHbar = (Number(amountWei) / 100_000_000).toFixed(4);
        } catch {
          continue;
        }
      }

      // Resolve Hedera tx ID for links
      let txId = log.transaction_hash;
      try {
        const txRes = await fetch(
          `https://mainnet.mirrornode.hedera.com/api/v1/transactions?timestamp=${log.timestamp}`,
          { headers: { Accept: "application/json" } }
        );
        if (txRes.ok) {
          const txData = await txRes.json();
          if (txData.transactions?.[0]?.transaction_id) {
            txId = txData.transactions[0].transaction_id;
          }
        }
      } catch {
        // fallback to hash
      }

      notifications.push({ txId, from, amountHbar, timestamp: log.timestamp });
      if (notifications.length >= 10) break;
    }

    return NextResponse.json({ notifications });
  } catch (err) {
    console.error("[notifications] Error:", err);
    return NextResponse.json({ notifications: [], error: "Failed to fetch" });
  }
}
