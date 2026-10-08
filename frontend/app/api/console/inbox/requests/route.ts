import { NextRequest, NextResponse } from "next/server";
import { readAgentConnectionRequests } from "@/lib/server/mcp-tools";

/**
 * GET /api/console/inbox/requests?username=<name>&limit=<1-25>
 *
 * Read-only connection management for the agent console (Phase 2): pending
 * HCS-10 connection requests sent TO this agent's inbound topic, read live
 * from the Hedera mainnet mirror node.
 *
 * Accepting a request happens in the recipient agent's own HCS-10 client
 * with its own key (it creates the shared connection topic) — this endpoint
 * only READS. There is no server-side accept/decline/block.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const username = (params.get("username") ?? "").trim();
  const limitRaw = params.get("limit");
  const limit =
    limitRaw !== null && limitRaw !== "" && Number.isFinite(Number(limitRaw))
      ? Math.max(1, Math.min(25, Math.floor(Number(limitRaw))))
      : 10;

  if (!username) {
    return NextResponse.json(
      { ok: false, error: "username is required" },
      { status: 400 },
    );
  }

  try {
    const result = await readAgentConnectionRequests(username, limit);
    if ("error" in result) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
