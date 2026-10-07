import { NextResponse } from "next/server";
import { getKvStore } from "@/lib/server/store";
import { defaultHcsPort } from "@/lib/server/townhall/hcs";
import { defaultRegistryPort } from "@/lib/server/townhall/registry-check";
import { siteUrl } from "@/lib/seo";
import { maybeBackfillSocial, readInbox } from "@/lib/server/notify";

/**
 * GET /api/notifications?address=0x...
 *
 * Returns recent notifications for a wallet address:
 *   - type "tip": TipSent events from the official Hedera mirror node
 *     (existing behavior — { txId, from, amountHbar, timestamp }).
 *   - type "reply" | "mention" | "follow" | "sale": social events from the
 *     wallet's KV inbox, written by the social sweep (POST /api/notify/check
 *     or the read-path backfill below).
 *
 * Response: { notifications: [...] } newest first, capped at 30.
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
      signal: AbortSignal.timeout(10_000),
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
          { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }
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

      notifications.push({ type: "tip", txId, from, amountHbar, timestamp: log.timestamp });
      if (notifications.length >= 10) break;
    }

    // Social events (reply / mention / follow / sale) from the wallet's
    // KV inbox. Backfill detection when the sweep is stale — no push.
    try {
      const kv = getKvStore();
      await maybeBackfillSocial(kv, defaultHcsPort(), defaultRegistryPort(), siteUrl());
      const social = await readInbox(kv, address);
      for (const n of social.slice(0, 20)) {
        notifications.push({
          type: n.type,
          id: n.id,
          tsMs: n.tsMs,
          actor: n.actor,
          title: n.title,
          body: n.body,
          url: n.url,
        });
      }
    } catch {
      // Social inbox is best-effort — tips still return honestly.
    }

    // Newest first across both sources; tips carry mirror-node timestamp
    // strings ("1234567890.123456789"), social items carry epoch ms.
    const tsOf = (n: { timestamp?: string; tsMs?: number }) =>
      typeof n.tsMs === "number" ? n.tsMs : Math.round(parseFloat(n.timestamp ?? "0") * 1000);
    notifications.sort((a, b) => tsOf(b) - tsOf(a));

    return NextResponse.json({ notifications: notifications.slice(0, 30) });
  } catch (err) {
    console.error("[notifications] Error:", err);
    return NextResponse.json({ notifications: [], error: "Failed to fetch" });
  }
}
