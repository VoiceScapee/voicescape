/**
 * GET /api/agent/chat/build-credit — does the caller's wallet hold an
 * unspent 5-HBAR build payment?
 *
 * The widget queries this when the build paywall shows (and polls after
 * the visitor pays) to render "payment detected" vs "no build credit yet".
 * It answers ONLY about the caller's own session wallet — never any other
 * wallet's data. Fails closed (503) when the store is unreachable rather
 * than claiming "unpaid".
 */
import { NextRequest, NextResponse } from "next/server";

import {
  agentChatClientIp,
  buildCreditRateLimited,
} from "@/lib/agent/rate-limit";
import { checkBuildAccess } from "../metering";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { verifySessionToken } from "@/lib/server/townhall/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (buildCreditRateLimited(agentChatClientIp(req))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const cred = sessionCredentialFrom(req);
  const verified = typeof cred === "string" ? verifySessionToken(cred) : null;
  if (!verified || !verified.ok) {
    return NextResponse.json({ signedIn: false, hasCredit: false });
  }
  try {
    const access = await checkBuildAccess(verified.session.address);
    const debug = req.nextUrl.searchParams.get("debug") === "1";
    if (debug) {
      // Temporary deep debug: call the REAL discoverFreshPayments
      const { discoverFreshPayments } = await import("@/app/api/agent/chat/metering");
      let deep: any = {};
      try {
        const realFresh = await discoverFreshPayments(verified.session.address.toLowerCase(), []);
        deep.realFresh = realFresh;
        deep.realFreshCount = realFresh.length;
      } catch (e) {
        deep.realError = e instanceof Error ? e.message : String(e);
      }
      return NextResponse.json({
        signedIn: true,
        hasCredit: access.allowed,
        debugAddr: verified.session.address,
        deep,
      });
    }
    return NextResponse.json({ signedIn: true, hasCredit: access.allowed });
  } catch {
    return NextResponse.json({ error: "credit_unavailable" }, { status: 503 });
  }
}
