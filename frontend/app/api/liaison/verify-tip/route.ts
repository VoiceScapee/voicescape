import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { globalQuotaStore, quotaExceededBody, quotaLimitFromEnv } from "@/lib/server/quota";
import { handleVerifyTip } from "@/lib/server/liaison/handlers";
import { liaisonRouteDeps, liaisonSessionAddr, readJsonBody, toResponse } from "../_shared";

export const runtime = "nodejs";

/**
 * POST /api/liaison/verify-tip — { txHash, product } | { scan: true, product }
 *
 * Verifies a tip to the liaison on the mirror node and grants credits for
 * one product: "chat" (50 messages) or "build" (1 page build), 7-day TTL.
 * Grants accumulate. Anti-replay: each transaction can unlock only one
 * product.
 */
export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "liaison-verify-tip",
    "IP_RATE_LIMIT_LIAISON_VERIFY_TIP",
    60,
    "too many verification requests from this network — try again later",
  );
  if (gated) return gated;

  const addr = await liaisonSessionAddr(req);
  if (!addr) {
    return NextResponse.json({ error: "sign in with your wallet first" }, { status: 401 });
  }

  const quota = await globalQuotaStore().consume(
    "liaison:verify-tip",
    addr,
    quotaLimitFromEnv("QUOTA_LIAISON_VERIFY_TIP", 20),
  );
  if (!quota.allowed) {
    return NextResponse.json(
      quotaExceededBody(quota, "too many tip verifications today — try again tomorrow"),
      { status: 429 },
    );
  }

  const body = await readJsonBody(req);
  const dd = liaisonRouteDeps();
  if (!dd.ok) return dd.response;
  const deps = dd.deps;
  return toResponse(await handleVerifyTip(deps, addr, body));
}
