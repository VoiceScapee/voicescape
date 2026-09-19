import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import {
  getDmcaAgentContact,
  submitNotice,
  validateNotice,
  type DmcaNoticeInput,
} from "@/lib/server/dmca/notices";

export const runtime = "nodejs";

/**
 * POST /api/dmca
 *
 * Submit a copyright notice or counter-notice. Records it with a receipt
 * timestamp (the §512(c) expeditious-removal clock starts here). Anyone may
 * file — no wallet session is required, because the reporter may not be a
 * Voicescape user. Rate-limited by IP to stop spam floods.
 *
 * Body: {kind: "notice"|"counter-notice", work, location, contactName,
 *        contact, reportedWallet?, goodFaith: true, perjuryStatement?,
 *        signature}
 *
 * 201 → {id, receivedAt}. Errors: 400 invalid, 429 rate-limited.
 */
export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "dmca",
    "IP_RATE_LIMIT_DMCA",
    10,
    "too many DMCA submissions from this network — try again later",
  );
  if (gated) return gated;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const input: DmcaNoticeInput = {
    kind: b.kind as DmcaNoticeInput["kind"],
    work: typeof b.work === "string" ? b.work : "",
    location: typeof b.location === "string" ? b.location : "",
    contactName: typeof b.contactName === "string" ? b.contactName : "",
    contact: typeof b.contact === "string" ? b.contact : "",
    reportedWallet: typeof b.reportedWallet === "string" ? b.reportedWallet : undefined,
    goodFaith: b.goodFaith === true,
    perjuryStatement: b.perjuryStatement === true,
    signature: typeof b.signature === "string" ? b.signature : "",
  };

  const errs = validateNotice(input);
  if (errs.length) {
    return NextResponse.json({ error: "Invalid notice", details: errs }, { status: 400 });
  }

  try {
    const notice = await submitNotice(input, "site");
    return NextResponse.json(
      {
        id: notice.id,
        receivedAt: notice.receivedAt,
        contact: getDmcaAgentContact(),
        note: "Your notice has been recorded. We review notices promptly and will act as required by law.",
      },
      { status: 201 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "could not record notice";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
