import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import {
  VerifierError,
  verifyAgentRegistration,
  type VerifyNetwork,
} from "@/lib/server/agents/verify-registration";

/**
 * GET /api/agents/verify-registration?username=<name> | ?accountId=0.0.x [&network=testnet]
 *
 * Read-only HCS-10 registration check. Verifies the three on-chain
 * artifacts every HCS-10 agent needs — inbound topic, outbound topic,
 * registry `register` message — via mirror-node REST only. No keys, no
 * chain writes, $0.
 *
 * Guardrails: per-IP rate limit (60/hr) plus a 10-minute server-side
 * result cache keyed by account. Without these, one polling client turns
 * each call into a mirror-node fan-out (topics scan + registry message
 * scan) that can blow the Vercel function's time budget.
 */

const CACHE_TTL_MS = 10 * 60_000;

export async function GET(req: NextRequest) {
  const gated = await ipGate(
    req,
    "agents-verify-registration",
    "IP_RATE_LIMIT_AGENTS_VERIFY",
    60,
    "too many verification requests from this network — try again later",
  );
  if (gated) return gated;

  const q = req.nextUrl.searchParams;
  const username = (q.get("username") ?? "").trim() || undefined;
  const accountId = (q.get("accountId") ?? "").trim() || undefined;
  const network: VerifyNetwork = q.get("network") === "testnet" ? "testnet" : "mainnet";

  if (!username && !accountId) {
    return NextResponse.json(
      { error: "provide ?username= or ?accountId=0.0.x" },
      { status: 400 },
    );
  }
  if (accountId && !/^0\.0\.\d+$/.test(accountId)) {
    return NextResponse.json(
      { error: "accountId must look like 0.0.x" },
      { status: 400 },
    );
  }

  // Cache key needs the resolved account; when only a username is given we
  // resolve first (cheap: our own cached directory + one mirror lookup),
  // then serve/cache on the canonical key.
  const cacheKey = (acct: string) => `agents:verify:${network}:${acct}:v1`;
  const serve = async (acct: string | null) => {
    if (acct) {
      try {
        const cached = await getKvStore().get(cacheKey(acct));
        if (cached) return NextResponse.json(JSON.parse(cached));
      } catch {
        /* fall through to a live check */
      }
    }
    try {
      const result = await verifyAgentRegistration({
        username,
        accountId,
        network,
        origin: req.nextUrl.origin,
      });
      try {
        await getKvStore().set(cacheKey(result.accountId), JSON.stringify(result), CACHE_TTL_MS);
      } catch {
        /* a missed cache write is not an error */
      }
      return NextResponse.json(result);
    } catch (e) {
      if (e instanceof VerifierError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      console.error("[agents] verify-registration error:", e);
      return NextResponse.json({ error: "verification failed" }, { status: 502 });
    }
  };

  // Fast path: accountId given → cache lookup without resolving anything.
  if (accountId) return serve(accountId);
  // Username path: resolve via verifyAgentRegistration (it reads our own
  // directory), then the canonical account key is used for caching inside.
  return serve(null);
}
