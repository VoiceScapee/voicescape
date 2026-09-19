import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { isFounderWallet } from "@/lib/server/client-errors";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import {
  isDataRightsKind,
  listDataRightsRequests,
  markDataRightsAnswered,
  submitDataRightsRequest,
} from "@/lib/server/privacy/data-rights";

export const runtime = "nodejs";

async function verifyWalletSession(req: NextRequest): Promise<{ ok: true; address: string } | { ok: false; error: string }> {
  const cred = sessionCredentialFrom(req);
  if (cred == null) return { ok: false, error: "sign in with your wallet to submit a data-rights request" };
  const res = await defaultAuthPort().verifySession(cred);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, address: res.session.address };
}

/**
 * POST /api/privacy-request {kind: "access"|"correction"|"deletion"|"restriction", details?}
 *
 * Submit a data-rights request (GDPR/CCPA). Requires a signed wallet
 * session — the request is keyed to the wallet so it can be answered. No
 * new PII is collected: no email, no name.
 *
 * 201 → {id, receivedAt}. Errors: 400 bad input, 401 no session.
 */
export async function POST(req: NextRequest) {
  const v = await verifyWalletSession(req);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = b.kind;
  const details = typeof b.details === "string" ? b.details : "";

  if (!isDataRightsKind(kind)) {
    return NextResponse.json(
      { error: "kind must be one of: access, correction, deletion, restriction" },
      { status: 400 },
    );
  }

  try {
    const r = await submitDataRightsRequest(v.address, kind, details);
    return NextResponse.json(
      {
        id: r.id,
        receivedAt: r.receivedAt,
        note: "Request recorded. Because we hold almost no data about you, most requests are answered with a simple confirmation — on-chain data can't be changed by us.",
      },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not record request" },
      { status: 400 },
    );
  }
}

/**
 * GET /api/privacy-request — founder-only queue of data-rights requests.
 * POST /api/privacy-request?action=answer {id} — founder marks one answered.
 */
export async function GET(req: NextRequest) {
  const v = await verifyWalletSession(req);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 401 });
  if (!isFounderWallet(v.address, process.env))
    return NextResponse.json({ error: "Data-rights requests are private — founders only" }, { status: 403 });
  const requests = await listDataRightsRequests(100);
  return NextResponse.json({ requests });
}

/** Founder marks a request answered. Body: {id}. */
export async function PUT(req: NextRequest) {
  const v = await verifyWalletSession(req);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 401 });
  if (!isFounderWallet(v.address, process.env))
    return NextResponse.json({ error: "Data-rights requests are private — founders only" }, { status: 403 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const id = (body as Record<string, unknown>)?.id;
  if (typeof id !== "string") return NextResponse.json({ error: "id is required" }, { status: 400 });
  const updated = await markDataRightsAnswered(id);
  if (!updated) return NextResponse.json({ error: "request not found" }, { status: 400 });
  return NextResponse.json({ request: updated });
}
