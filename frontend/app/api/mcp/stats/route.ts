/**
 * GET /api/mcp/stats — public aggregate MCP usage numbers.
 *
 * Anonymous counters only (see lib/server/mcp-usage-stats.ts): total tool
 * calls in the rolling 30-day window, per-tool totals, per-day totals.
 * No IPs, no arguments, no wallet data — nothing that identifies anyone.
 * Also includes the intro-board count so "agents actually using the MCP"
 * is one honest number next to the call volume.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getMcpUsageStats } from "@/lib/server/mcp-usage-stats";
import { listAgentIntros } from "@/lib/server/agent-intros";

export async function GET(): Promise<Response> {
  const [usage, intros] = await Promise.all([
    getMcpUsageStats(),
    listAgentIntros().catch(() => []),
  ]);
  return NextResponse.json({
    window_days: 30,
    tool_calls_total: usage.total,
    tool_calls_by_day: usage.byDay,
    introductions_total: intros.length,
    updated_at: new Date().toISOString(),
  });
}
