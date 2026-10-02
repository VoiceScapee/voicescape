import { NextRequest, NextResponse } from "next/server";
import { listWorkshopReports } from "@/lib/server/agent-workshop";

export const runtime = "nodejs";

/**
 * GET /api/workshop/reports?category=bug|idea&status=&limit=
 * Public list of Agent Workshop reports (newest first).
 */
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const category = sp.get("category");
  const status = sp.get("status");
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 30) || 30, 1), 100);
  const reports = await listWorkshopReports({
    ...(category === "bug" || category === "idea" ? { category } : {}),
    ...(status === "new" || status === "confirmed" || status === "fixing" || status === "shipped"
      ? { status }
      : {}),
    limit,
  });
  return NextResponse.json({ reports });
}
