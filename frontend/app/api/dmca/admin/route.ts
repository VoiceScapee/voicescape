import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultClientErrorAdminDeps, isFounderWallet } from "@/lib/server/client-errors";
import {
  getNotice,
  listNotices,
  setNoticeStatus,
} from "@/lib/server/dmca/notices";
import { getCopyrightStatus, recordStrike } from "@/lib/server/dmca/strikes";
import { canonicalAddress } from "@/lib/session-message";

export const runtime = "nodejs";

async function requireFounder(req: NextRequest): Promise<{ ok: true; address: string } | { ok: false; status: number; error: string }> {
  const cred = sessionCredentialFrom(req);
  if (cred == null)
    return { ok: false, status: 401, error: "sign in with your wallet to manage DMCA notices" };
  const deps = defaultClientErrorAdminDeps();
  const verified = await deps.verifySession(cred);
  if (!verified.ok) return { ok: false, status: 401, error: verified.error };
  if (!isFounderWallet(verified.address, process.env))
    return { ok: false, status: 403, error: "DMCA notices are private — founders only" };
  return { ok: true, address: verified.address };
}

/**
 * GET /api/dmca/admin
 *
 * Founder-only DMCA notice queue, newest first. 200 { notices }.
 */
export async function GET(req: NextRequest) {
  const f = await requireFounder(req);
  if (!f.ok) return NextResponse.json({ error: f.error }, { status: f.status });
  try {
    const notices = await listNotices(100);
    // Never leak reporter PII to anyone but the founder (already gated),
    // and keep the response shape stable.
    return NextResponse.json({ notices });
  } catch {
    return NextResponse.json({ error: "could not read DMCA notices — try again in a moment" }, { status: 503 });
  }
}

/**
 * POST /api/dmca/admin {id, action: "takedown" | "dismiss"}
 *
 * Resolve a notice. "takedown" marks the notice actioned AND records one
 * copyright strike against the reported wallet (one strike per executed
 * takedown — the repeat-infringer pipeline behind ToS §12). "dismiss"
 * marks it dismissed with no strike. Wallets that hit the strike threshold
 * are suspended from town-hall writes until cleared on appeal.
 *
 * 200 → {notice, strike?}. Errors: 400 bad input/unknown notice,
 * 401/403 not founder.
 */
export async function POST(req: NextRequest) {
  const f = await requireFounder(req);
  if (!f.ok) return NextResponse.json({ error: f.error }, { status: f.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id : "";
  const action = b.action === "takedown" || b.action === "dismiss" ? b.action : "";

  const notice = await getNotice(id);
  if (!notice) return NextResponse.json({ error: "notice not found" }, { status: 400 });
  if (!action) return NextResponse.json({ error: "action must be 'takedown' or 'dismiss'" }, { status: 400 });

  const status = action === "takedown" ? "actioned" : "dismissed";
  const updated = await setNoticeStatus(id, status, f.address);

  let strike: Awaited<ReturnType<typeof getCopyrightStatus>> | null = null;
  if (action === "takedown" && notice.reportedWallet) {
    const canon = canonicalAddress(notice.reportedWallet);
    if (canon) {
      strike = await recordStrike(canon, id);
    }
  }

  return NextResponse.json({ notice: updated, strike });
}
