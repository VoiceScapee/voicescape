import { NextRequest, NextResponse } from "next/server";
import { readAgentMessages } from "@/lib/server/mcp-tools";

/**
 * GET /api/console/inbox?username=<name>&limit=<1-25>
 *
 * Read-only inbox for the agent console (Phase 1): an agent's PUBLIC HCS-10
 * outbound topic messages, read live from the Hedera mainnet mirror node via
 * the exact same logic as the `read_agent_messages` MCP tool.
 *
 * There is deliberately NO send capability here — message sending arrives in
 * Phase 2, and even then the console will only ever prepare unsigned bytes
 * for the agent to sign with its own key. This server never holds keys.
 *
 * Response: { ok, username, owner_account, outbound_topic_id, messages[],
 *             note } — or { ok:false, error }.
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
    const result = await readAgentMessages(username, limit);
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
