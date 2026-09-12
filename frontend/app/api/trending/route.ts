import { NextResponse } from "next/server";

/**
 * GET /api/trending
 *
 * Algorithmic feed: pages ranked by recent on-chain tip activity.
 * Aggregates TipSent events from the last 7 days, scores by
 * total HBAR received + tip count, returns ranked pages.
 */

const TIPSENT_TOPIC = "0xddb557901a5c7e767f2276c1190ca61ae148d62a74cfa61e4f7fa5319eaa431e";
const TIPS_CONTRACT = "0.0.10854060";
const REGISTRY_ID = "0.0.10854058";

export async function GET() {
  try {
    // Get TipSent logs from last 7 days (limit 100)
    const logsUrl =
      `https://mainnet.mirrornode.hedera.com/api/v1/contracts/${TIPS_CONTRACT}/results/logs` +
      `?order=desc&limit=100`;

    const logsRes = await fetch(logsUrl, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 },
    });

    if (!logsRes.ok) throw new Error("Mirror Node unavailable");

    const logsData = await logsRes.json();
    const logs = (logsData.logs || []).filter(
      (l: any) => l.topics?.[0]?.toLowerCase() === TIPSENT_TOPIC
    );

    // Aggregate by recipient
    const scores = new Map<string, { totalHbar: number; count: number }>();

    for (const log of logs) {
      const to = log.topics[3] ? "0x" + log.topics[3].slice(-40).toLowerCase() : null;
      if (!to) continue;

      let amountHbar = 0;
      if (log.data && log.data.length >= 66) {
        try {
          const amountWei = BigInt("0x" + log.data.slice(2, 66));
          amountHbar = Number(amountWei) / 100_000_000;
        } catch {
          continue;
        }
      }

      const existing = scores.get(to) || { totalHbar: 0, count: 0 };
      scores.set(to, {
        totalHbar: existing.totalHbar + amountHbar,
        count: existing.count + 1,
      });
    }

    // Score: total HBAR * (1 + log(count)) — rewards both volume and frequency
    const ranked = Array.from(scores.entries())
      .map(([address, stats]) => ({
        address,
        totalHbar: stats.totalHbar.toFixed(2),
        tipCount: stats.count,
        score: stats.totalHbar * (1 + Math.log(stats.count + 1)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    return NextResponse.json({
      trending: ranked,
      count: ranked.length,
    });
  } catch (err) {
    console.error("[trending] Error:", err);
    return NextResponse.json({ trending: [], count: 0 });
  }
}
