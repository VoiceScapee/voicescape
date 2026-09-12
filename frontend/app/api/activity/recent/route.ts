import { NextResponse } from "next/server";

/**
 * GET /api/activity/recent
 *
 * Returns recent on-chain activity (tips) from the VoicescapeTips contract.
 * Queries Hedera Mirror Node for TipSent events, newest first.
 *
 * Response: { tips: [{ txHash, from, to, amountHbar, timestamp }] }
 */
export async function GET() {
  try {
    const tipsAddress = process.env.NEXT_PUBLIC_TIPS_ADDRESS;
    if (!tipsAddress) {
      return NextResponse.json({ tips: [], error: "Tips contract not configured" });
    }

    // Convert EVM address to Hedera ID format for Mirror Node
    // The contract is 0.0.10854060
    const contractId = "0.0.10854060";

    // Query Mirror Node for contract results (which include logs)
    const url = `https://mainnet.mirrornode.hedera.com/api/v1/contracts/${contractId}/results?order=desc&limit=20`;

    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      next: { revalidate: 60 }, // Cache for 60 seconds
    });

    if (!res.ok) {
      return NextResponse.json({ tips: [], error: "Mirror Node unavailable" });
    }

    const data = await res.json();
    const results = data.results || [];

    // Filter for payable calls (tips have amount > 0)
    // The list includes amount, from, to, timestamp directly
    const tips = [];
    for (const r of results.slice(0, 10)) {
      if (!r.amount || r.amount === 0) continue;
      if (r.error_message) continue; // Skip failed

      const amountHbar = r.amount / 100_000_000;

      tips.push({
        txHash: r.hash,
        from: r.from,
        to: r.to,
        amountHbar: amountHbar.toFixed(4),
        timestamp: r.timestamp,
      });

      if (tips.length >= 5) break;
    }

    return NextResponse.json({ tips });
  } catch (err) {
    console.error("[activity] Error fetching recent activity:", err);
    return NextResponse.json({ tips: [], error: "Failed to fetch activity" });
  }
}
