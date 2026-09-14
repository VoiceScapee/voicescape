import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { globalQuotaStore, quotaExceededBody, quotaLimitFromEnv } from "@/lib/server/quota";
import { handleChat } from "@/lib/server/liaison/handlers";
import { liaisonRouteDeps, liaisonSessionAddr, readJsonBody, toResponse } from "../_shared";

export const runtime = "nodejs";

/**
 * POST /api/liaison/chat — { message }
 *
 * Deterministic knowledge-base answers (no LLM in slice 1). Costs one
 * free message (first 3 per wallet) or one paid chat credit; 402 when
 * neither remains.
 */
export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "liaison-chat",
    "IP_RATE_LIMIT_LIAISON_CHAT",
    120,
    "too many chat requests from this network — try again later",
  );
  if (gated) return gated;

  const addr = await liaisonSessionAddr(req);
  if (!addr) {
    return NextResponse.json({ error: "sign in with your wallet first" }, { status: 401 });
  }

  const quota = await globalQuotaStore().consume(
    "liaison:chat",
    addr,
    quotaLimitFromEnv("QUOTA_LIAISON_CHAT", 50),
  );
  if (!quota.allowed) {
    return NextResponse.json(
      quotaExceededBody(quota, "daily chat limit reached — try again tomorrow"),
      { status: 429 },
    );
  }

  const body = await readJsonBody(req);
  const dd = liaisonRouteDeps();
  if (!dd.ok) return dd.response;
  const deps = dd.deps;
  return toResponse(await handleChat(deps, addr, body));
}
