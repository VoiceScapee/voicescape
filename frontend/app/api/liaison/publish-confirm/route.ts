import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { globalQuotaStore, quotaExceededBody, quotaLimitFromEnv } from "@/lib/server/quota";
import { handlePublishConfirm } from "@/lib/server/liaison/handlers";
import { liaisonRouteDeps, liaisonSessionAddr, readJsonBody, toResponse } from "../_shared";

export const runtime = "nodejs";

/**
 * POST /api/liaison/publish-confirm — { username, txHash }
 *
 * Confirms the user's OWN wallet-signed registerPage transaction on the
 * mirror node, then deletes their draft. The liaison never publishes —
 * this only verifies the handoff happened.
 */
export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "liaison-publish-confirm",
    "IP_RATE_LIMIT_LIAISON_PUBLISH_CONFIRM",
    60,
    "too many requests from this network — try again later",
  );
  if (gated) return gated;

  const addr = await liaisonSessionAddr(req);
  if (!addr) {
    return NextResponse.json({ error: "sign in with your wallet first" }, { status: 401 });
  }

  const quota = await globalQuotaStore().consume(
    "liaison:publish-confirm",
    addr,
    quotaLimitFromEnv("QUOTA_LIAISON_PUBLISH_CONFIRM", 20),
  );
  if (!quota.allowed) {
    return NextResponse.json(
      quotaExceededBody(quota, "too many confirmations today — try again tomorrow"),
      { status: 429 },
    );
  }

  const body = await readJsonBody(req);
  const dd = liaisonRouteDeps();
  if (!dd.ok) return dd.response;
  const deps = dd.deps;
  return toResponse(await handlePublishConfirm(deps, addr, body));
}
