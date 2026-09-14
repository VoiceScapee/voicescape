import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { globalQuotaStore, quotaExceededBody, quotaLimitFromEnv } from "@/lib/server/quota";
import {
  handleDraftDelete,
  handleDraftGet,
  handleDraftPost,
} from "@/lib/server/liaison/handlers";
import { liaisonRouteDeps, liaisonSessionAddr, readJsonBody, toResponse } from "../_shared";

export const runtime = "nodejs";

/**
 * /api/liaison/draft — the wallet-bound premade blockpage.
 *
 * GET: fetch my draft. POST: assemble + store a draft (costs one paid
 * build credit; one active draft per wallet, overwritten). DELETE: discard.
 */
async function requireAddr(req: NextRequest): Promise<string | NextResponse> {
  const addr = await liaisonSessionAddr(req);
  if (!addr) {
    return NextResponse.json({ error: "sign in with your wallet first" }, { status: 401 });
  }
  return addr;
}

export async function GET(req: NextRequest) {
  const gated = await ipGate(
    req,
    "liaison-draft",
    "IP_RATE_LIMIT_LIAISON_DRAFT",
    120,
    "too many draft requests from this network — try again later",
  );
  if (gated) return gated;
  const addr = await requireAddr(req);
  if (addr instanceof NextResponse) return addr;
  const dd = liaisonRouteDeps();
  if (!dd.ok) return dd.response;
  const deps = dd.deps;
  return toResponse(await handleDraftGet(deps, addr));
}

export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "liaison-draft",
    "IP_RATE_LIMIT_LIAISON_DRAFT",
    60,
    "too many draft requests from this network — try again later",
  );
  if (gated) return gated;
  const addr = await requireAddr(req);
  if (addr instanceof NextResponse) return addr;

  const dd = liaisonRouteDeps();
  if (!dd.ok) return dd.response;
  const deps = dd.deps;

  const quota = await globalQuotaStore().consume(
    "liaison:draft",
    addr,
    quotaLimitFromEnv("QUOTA_LIAISON_DRAFT", 3),
  );
  if (!quota.allowed) {
    return NextResponse.json(
      quotaExceededBody(quota, "daily page-build limit reached — try again tomorrow"),
      { status: 429 },
    );
  }

  const body = await readJsonBody(req);
  return toResponse(await handleDraftPost(deps, addr, body));
}

export async function DELETE(req: NextRequest) {
  const gated = await ipGate(
    req,
    "liaison-draft",
    "IP_RATE_LIMIT_LIAISON_DRAFT",
    120,
    "too many draft requests from this network — try again later",
  );
  if (gated) return gated;
  const addr = await requireAddr(req);
  if (addr instanceof NextResponse) return addr;
  const dd = liaisonRouteDeps();
  if (!dd.ok) return dd.response;
  const deps = dd.deps;
  return toResponse(await handleDraftDelete(deps, addr));
}
