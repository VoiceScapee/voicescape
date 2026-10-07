import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { defaultDeps } from "@/lib/server/townhall/handlers";
import { walletPurchases } from "@/lib/server/townhall/badges";
import { defaultHcsPort } from "@/lib/server/townhall/hcs";
import { getTopicId } from "@/lib/server/townhall/topics";
import { aggregateListings } from "@/lib/server/townhall/votes";

export const runtime = "nodejs";

/**
 * GET /api/townhall/market/purchases?wallet=…
 * → { purchases: [{ listingRef, title, tx, timestamp, goodsType, ipfsHash, sellerUsername }] }
 *
 * Chain-derived purchase history: every PurchaseCompleted event for the
 * wallet on the Tips contract, resolved against the market topic. This is
 * the cross-device source of truth — unlike the old browser-localStorage
 * purchase list, it survives device changes and can't be faked.
 */
export async function GET(req: NextRequest) {
  const gated = await ipGate(
    req,
    "townhall",
    "IP_RATE_LIMIT_TOWNHALL",
    300,
    "too many requests from this network — try again later",
  );
  if (gated) return gated;

  const wallet = (req.nextUrl.searchParams.get("wallet") ?? "").trim();
  if (!wallet) {
    return NextResponse.json({ error: "wallet is required" }, { status: 400 });
  }

  const deps = defaultDeps();
  const [purchases, listingMeta] = await Promise.all([
    walletPurchases(defaultHcsPort(), wallet),
    (async () => {
      const meta = new Map<string, { goodsType: string; ipfsHash: string | null; sellerUsername: string | null }>();
      try {
        const topic = getTopicId("market");
        if (!topic) return meta;
        const messages = await deps.hcs.queryAll(topic);
        for (const [, m] of aggregateListings(messages)) {
          meta.set(m.contents.id, {
            goodsType: m.contents.goodsType,
            ipfsHash: m.contents.ipfsHash ?? null,
            sellerUsername: m.contents.sellerUsername ?? null,
          });
        }
      } catch {
        /* meta stays empty — purchases still list */
      }
      return meta;
    })(),
  ]);

  return NextResponse.json({
    purchases: purchases.map((p) => {
      const meta = listingMeta.get(p.listingRef);
      return {
        listingRef: p.listingRef,
        title: p.title,
        tx: p.tx,
        timestamp: p.timestamp,
        goodsType: meta?.goodsType ?? null,
        ipfsHash: meta?.ipfsHash ?? null,
        sellerUsername: meta?.sellerUsername ?? null,
      };
    }),
  });
}
