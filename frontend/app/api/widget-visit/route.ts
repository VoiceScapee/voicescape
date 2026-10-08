/**
 * POST /api/widget-visit — beacon fired by blockpages when the URL carries
 * a widget-instance id (?wid=). Completes the open-link delivery
 * diagnostic: render_blockpage issues a wid, the widget appends it to
 * open-link URLs, and this beacon proves the round trip completed.
 *
 * FROZEN BEACON SPEC (2026-10-07 — see frontend/docs/widget-beacon-spec.md):
 * the beacon shape is {wid, iid}. Both fields are REQUIRED.
 * - wid: 8-char widget-instance id minted by render_blockpage (1:1).
 * - iid: the caller's JSON-RPC request id (invocation correlation key),
 *   threaded through render_blockpage as _iid on success AND failure.
 *
 * Missing/empty iid is a HARD FAIL (400 + MISSING_IID), not a quiet
 * null — autonomaavalix's ask 2026-10-07: silent drops make ingest-side
 * validation impossible to debug.
 *
 * No auth — the wid is a random 8-char id (no PII), iid is opaque.
 * Returns 400 on INVALID_WID / UNKNOWN_WID / MISSING_IID, 429 when the
 * per-IP flood bound trips.
 */
import { NextResponse } from "next/server";
import { isWidgetId, logWidgetVisit, wasWidgetIssued } from "@/lib/server/widget-diagnostics";
import { ipGate } from "@/lib/server/rate-limit";
import {
  WIDGET_VISIT_ERRORS,
  type WidgetVisitErrorCode,
} from "@/lib/server/widget-beacon";

function err(code: WidgetVisitErrorCode) {
  return NextResponse.json(
    { ok: false, error: code, message: WIDGET_VISIT_ERRORS[code] },
    { status: 400 },
  );
}

export async function POST(req: Request) {
  // Per-IP flood bound — every hit can do up to two KV writes.
  const gated = await ipGate(
    req,
    "widget-visit",
    "IP_RATE_LIMIT_WIDGET_VISIT",
    120,
    "too many widget beacons from this network — try again later",
  );
  if (gated) return gated;
  const body = await req.json().catch(() => ({}));
  const wid = (body as { wid?: unknown }).wid;
  const iid = (body as { iid?: unknown }).iid;

  if (!isWidgetId(wid)) return err("INVALID_WID");
  if (!(await wasWidgetIssued(wid))) return err("UNKNOWN_WID");
  // iid is required: 1–128 chars. Empty/missing/wrong-type is a hard
  // 400, never a silent null.
  if (typeof iid !== "string" || iid.length === 0 || iid.length > 128) {
    return err("MISSING_IID");
  }
  await logWidgetVisit(wid, iid);
  return NextResponse.json({ ok: true });
}
