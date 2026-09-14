import { NextResponse } from "next/server";
import { buildAgentCard } from "@/lib/a2a/card";
import { siteUrl } from "@/lib/seo";

/**
 * GET /.well-known/agent-card.json — A2A AgentCard for Echo.
 *
 * A2A Protocol v1.0.0 (Linux Foundation), §8.2: the well-known URI is the
 * standard discovery mechanism — clients fetch this to learn the agent's
 * identity, skills, and where to send JSON-RPC messages.
 *
 * Public, unauthenticated, cacheable. No secrets, no chain access.
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
