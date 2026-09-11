import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import {
  defaultDeps,
  getMyRestriction,
  type AuthBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * GET /api/townhall/me/restriction
 *
 * The signed-in wallet's own enforcement state:
 * {status: "clean"|"warned"|"timed-out"|"temp-banned"|"banned",
 *  reason, remainingMs, expiresAt}.
 *
 * Session required; anyone may check their own restriction (no mod
 * gate). Fail-open: when HCS is unreadable the wallet reports clean —
 * the write path enforces restrictions independently.
 */
export async function GET(req: NextRequest) {
  const { status, json } = await getMyRestriction(defaultDeps(), withAuth({} as AuthBody, req));
  return NextResponse.json(json, { status });
}
