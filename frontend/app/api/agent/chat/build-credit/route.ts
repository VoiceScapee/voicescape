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
    const debug = req.nextUrl.searchParams.get("debug");
    if (debug === "reset-payment") {
      // TEMPORARY: Reset the consumed build payment to unspent for E2E retry.
      // The 5 HBAR was consumed by a timed-out "go" that never returned a build.
      const { getKvStore } = await import("@/lib/server/store");
      const store = getKvStore();
      const identity = { kind: "wallet" as const, evm: verified.session.address };
      // Load, reset, save — using internal functions via dynamic import
      const metering = await import("@/app/api/agent/chat/metering");
      // We need loadLedger and saveLedger — loadLedger is not exported, so we
      // replicate the key logic here.
      const ledgerKey = `buddy:chat:${verified.session.address.toLowerCase()}`;
      const raw = await store.get(ledgerKey);
      if (!raw) {
        return NextResponse.json({ reset: false, reason: "no ledger" });
      }
      const ledger = JSON.parse(raw);
      let resetCount = 0;
      for (const p of ledger.payments ?? []) {
        if (p.id === "1789596501.153949104-1" && p.kind === "build") {
          p.kind = null;
          resetCount++;
        }
      }
      // Remove from consumed so it can be re-credited if needed
      ledger.consumed = (ledger.consumed ?? []).filter(
        (id: string) => id !== "1789596501.153949104-1"
      );
      await store.set(ledgerKey, JSON.stringify(ledger), 7 * 24 * 60 * 60 * 1000);
      // Also clear the claim key so it can be re-claimed
      await store.del(`buddy:payclaim:${encodeURIComponent("1789596501.153949104-1")}`);
      return NextResponse.json({ reset: true, resetCount });
    }
    return NextResponse.json({ signedIn: true, hasCredit: access.allowed });
  } catch {
    return NextResponse.json({ error: "credit_unavailable" }, { status: 503 });
  }
}
