import { NextResponse } from "next/server";
import { buildAgentCard } from "@/lib/a2a/card";
import { siteUrl } from "@/lib/seo";

/**
 * GET /.well-known/agent.json — legacy alias for the A2A AgentCard.
 *
 * A2A v0.3 used `/.well-known/agent.json`; v1.0 renamed it to
 * `/.well-known/agent-card.json`. Both serve the identical card so older
 * clients in the wild still discover us.
 */
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(buildAgentCard(siteUrl()), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
