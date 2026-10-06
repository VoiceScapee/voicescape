/**
 * POST /api/widget-visit — beacon fired by blockpages when the URL carries
 * a widget-instance id (?wid=). Completes the open-link delivery
 * diagnostic: render_blockpage issues a wid, the widget appends it to
 * open-link URLs, and this beacon proves the round trip completed.
 *
 * Optional `iid` carries the caller's JSON-RPC request id (invocation
 * correlation key, autonomaavalix's ask 2026-10-06) so independent
 * observers can join beacon rows against their request log. A missing,
 * empty, or oversized iid is stored under the explicit "unattributed"
 * sentinel — never a quiet null.
 *
 * No auth — the wid is a random 8-char id (no PII), iid is opaque.
 * Invalid or unissued wids are ignored. Best-effort; always returns 200.
 */
import { NextResponse } from "next/server";
import {
  isUsableIid,
  isWidgetId,
  logWidgetVisit,
  wasWidgetIssued,
} from "@/lib/server/widget-diagnostics";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const wid = (body as { wid?: unknown }).wid;
    const iid = (body as { iid?: unknown }).iid;
    if (isWidgetId(wid) && (await wasWidgetIssued(wid))) {
      // Unusable iid (missing/empty/oversized) lands in the explicit
      // "unattributed" bucket inside logWidgetVisit — never a quiet null.
      await logWidgetVisit(wid, isUsableIid(iid) ? iid : undefined);
    }
  } catch {
    /* best-effort */
  }
  return NextResponse.json({ ok: true });
}
