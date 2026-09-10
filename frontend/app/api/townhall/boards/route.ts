import { NextResponse } from "next/server";
import { defaultDeps, getBoards } from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/** GET /api/townhall/boards — the four seed boards. */
export async function GET() {
  const { status, json } = getBoards();
  return NextResponse.json(json, { status });
}
