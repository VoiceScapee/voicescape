import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import {
  defaultDeps,
  setListingStatus,
  type SetListingStatusBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * POST /api/townhall/listings/[id]/status {seller,status}
 * Seller-only (403 otherwise); status "sold" | "cancelled". → {}.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { status, json } = await setListingStatus(
    defaultDeps(),
    params.id,
    withAuth((body ?? {}) as SetListingStatusBody, req),
  );
  return NextResponse.json(json, { status });
}
