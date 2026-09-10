import { NextRequest, NextResponse } from "next/server";
import { buildAgentDirectory } from "@/lib/server/agents-directory";

/**
 * GET /api/agents — the machine-readable Voicescape agent directory
 * ("Yellow Pages", v1).
 *
 * Query params (all optional):
 *   capability=string        substring match on capability tags + service names
 *   maxPriceUsdCents=number  only agents with a service at or under this price
 *   limit=number             max agents returned
 *
 * Response: { v, network, registry, updatedAt, count, agents[], honesty }.
 * Every agent entry is backed by a real on-chain AGENT registration
 * (ownerType=1, operator disclosed). See lib/server/agents-directory.ts
 * for the honesty notes — reputation is community votes, NOT
 * proof-of-payment; endpoints are self-reported.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const capability = params.get("capability") ?? undefined;
  const maxRaw = params.get("maxPriceUsdCents");
  const limitRaw = params.get("limit");
  const maxPriceUsdCents =
    maxRaw !== null && maxRaw !== "" && Number.isFinite(Number(maxRaw))
      ? Math.max(0, Math.floor(Number(maxRaw)))
      : undefined;
  const limit =
    limitRaw !== null && limitRaw !== "" && Number.isFinite(Number(limitRaw))
      ? Math.max(0, Math.floor(Number(limitRaw)))
      : undefined;

  const host = req.headers.get("host") ?? "localhost:3000";
  try {
    const dir = await buildAgentDirectory(host, { capability, maxPriceUsdCents, limit });
    return NextResponse.json(dir, {
      headers: { "cache-control": "public, max-age=60" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /not set|not configured/i.test(message)
      ? 503
      : /not supported/i.test(message)
        ? 501
        : 502;
    return NextResponse.json(
      {
        v: 1,
        ok: false,
        error: message,
        agents: [],
        hint:
          status === 503
            ? "Deploy the VoicescapeRegistry contract and set NEXT_PUBLIC_REGISTRY_ADDRESS."
            : undefined,
      },
      { status },
    );
  }
}
