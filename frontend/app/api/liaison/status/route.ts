import { NextRequest } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { handleStatus } from "@/lib/server/liaison/handlers";
import { liaisonRouteDeps, liaisonSessionAddr, toResponse } from "../_shared";

export const runtime = "nodejs";

/**
 * GET /api/liaison/status — public prices + (when signed in) the wallet's
 * remaining credits.
 */
export async function GET(req: NextRequest) {
  const gated = await ipGate(
    req,
    "liaison-status",
    "IP_RATE_LIMIT_LIAISON_STATUS",
    120,
    "too many status requests from this network — try again later",
  );
  if (gated) return gated;

  const addr = await liaisonSessionAddr(req);
  const dd = liaisonRouteDeps();
  if (!dd.ok) return dd.response;
  const deps = dd.deps;
  return toResponse(await handleStatus(deps, addr));
}
