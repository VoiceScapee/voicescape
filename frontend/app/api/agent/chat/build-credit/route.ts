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
      // Temporary deep debug: replicate discovery steps inline
      let deep: any = {};
      try {
        const addr = verified.session.address;
        const m = /^0x0{24}([0-9a-fA-F]{16})$/.exec(addr.trim());
        deep.regexMatch = !!m;
        deep.accountId = m ? `0.0.${BigInt("0x" + m[1]).toString()}` : null;
        if (deep.accountId) {
          const r = await fetch(`https://mainnet.mirrornode.hedera.com/api/v1/accounts/${deep.accountId}`);
          deep.acctOk = r.ok;
          deep.acctStatus = r.status;
          if (r.ok) {
            const b = await r.json();
            deep.evm = b.evm_address;
          } else {
            deep.acctText = (await r.text()).slice(0, 200);
          }
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const fromSec = nowSec - 6 * 24 * 3600;
        const lr = await fetch(
          `https://mainnet.mirrornode.hedera.com/api/v1/contracts/0.0.10854060/results/logs?order=desc&limit=100&timestamp=gte:${fromSec}.000000000&timestamp=lte:${nowSec}.999999999`
        );
        deep.logsOk = lr.ok;
        deep.logsStatus = lr.status;
        if (lr.ok) {
          const lb = await lr.json();
          deep.logCount = lb.logs?.length;
        }
      } catch (e) {
        deep.error = e instanceof Error ? e.message : String(e);
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
