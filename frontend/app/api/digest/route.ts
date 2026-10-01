import { NextRequest, NextResponse } from "next/server";
import { getKvStore } from "@/lib/server/store";
import { defaultHcsPort } from "@/lib/server/townhall/hcs";
import { defaultRegistryPort } from "@/lib/server/townhall/registry-check";
import { siteUrl } from "@/lib/seo";
import {
  addressForms,
  clampSinceMs,
  fetchTipItems,
  maybeBackfillSocial,
  readInbox,
  type DigestItem,
  type NotifType,
} from "@/lib/server/notify";

export const runtime = "nodejs";

/**
 * GET /api/digest?address=0x…&since=<epoch ms>
 *
 * "While you were away": counts + latest items per notification type
 * since a client-supplied timestamp.
 *
 * Sources:
 *   - tips: on-chain TipSent logs for the address, via the official
 *     Hedera mirror node (same source as /api/notifications).
 *   - reply / mention / follow / sale: the wallet's KV inbox, written by
 *     the social sweep (POST /api/notify/check, or the read-path
 *     backfill below).
 *
 * Privacy: the `since` watermark is supplied by the client and stays in
 * the client's localStorage — the server stores no visit history.
 * Address-scoped like /api/notifications; everything returned is derived
 * from public on-chain/HCS data.
 *
 * Response: { since, counts: { tip, reply, mention, follow, sale }, items }
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawAddress = searchParams.get("address")?.trim() ?? "";
  const forms = addressForms(rawAddress);
  const address = forms.find((f) => /^0x[0-9a-f]{40}$/.test(f) || /^0\.0\.\d+$/.test(f));
  if (!address) {
    return NextResponse.json({ error: "valid address required" }, { status: 400 });
  }
  const sinceMs = clampSinceMs(searchParams.get("since"));

  const kv = getKvStore();
  // Populate the inbox when the sweep is stale — detection only, no push.
  await maybeBackfillSocial(kv, defaultHcsPort(), defaultRegistryPort(), siteUrl());

  const [tips, social] = await Promise.all([
    fetchTipItems(address, sinceMs),
    readInbox(kv, address).then((items) => items.filter((n) => n.tsMs > sinceMs)),
  ]);

  const items: DigestItem[] = [...tips, ...social]
    .sort((a, b) => b.tsMs - a.tsMs)
    .slice(0, 50);

  const counts: Record<NotifType, number> = { tip: 0, reply: 0, mention: 0, follow: 0, sale: 0 };
  for (const item of [...tips, ...social]) {
    counts[item.type] += 1;
  }

  return NextResponse.json({ since: sinceMs, counts, items });
}
