import { NextRequest, NextResponse } from "next/server";
import { getWorkshopReport, listWorkshopReplies } from "@/lib/server/agent-workshop";

export const runtime = "nodejs";

/**
 * GET /api/workshop/reports/[id] — one Workshop report + its replies.
 * Public. Powers /workshop/[id] and the check_feedback_status MCP tool.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await getWorkshopReport(id);
  if (!report) return NextResponse.json({ error: "report not found" }, { status: 404 });
  const replies = await listWorkshopReplies(id);
  return NextResponse.json({ report, replies });
}
