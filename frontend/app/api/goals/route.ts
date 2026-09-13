import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultGoalDeps, readGoal, writeGoal, clearGoal } from "@/lib/server/goals";
import { getKvStore } from "@/lib/server/store";

export const runtime = "nodejs";

/**
 * GET /api/goals?username=<name> — public read.
 * 200 → { goal: FundingGoal | null }
 */
export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username") ?? "";
  try {
    const goal = await readGoal(getKvStore(), username);
    return NextResponse.json({ goal });
  } catch {
    return NextResponse.json({ goal: null });
  }
}

/**
 * POST /api/goals — set (create or replace) a funding goal.
 * Session-checked (x-vs-session); the wallet must own the username
 * on-chain. Body: { username, targetHbar, title? }.
 * 200 → { ok: true, goal } · 400 bad input · 401 not signed in
 * · 403 not the owner · 404 page not found · 503 store unavailable.
 */
export async function POST(req: NextRequest) {
  const cred = sessionCredentialFrom(req);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const username = (body as { username?: unknown } | null)?.username;
  const { status, json } = await writeGoal(defaultGoalDeps(), username, body, cred);
  return NextResponse.json(json, { status });
}

/**
 * DELETE /api/goals?username=<name> — clear the funding goal.
 * Session-checked (x-vs-session); the wallet must own the username.
 * 200 → { ok: true, goal: null } · same gates as POST.
 */
export async function DELETE(req: NextRequest) {
  const cred = sessionCredentialFrom(req);
  const username = req.nextUrl.searchParams.get("username") ?? "";
  const { status, json } = await clearGoal(defaultGoalDeps(), username, cred);
  return NextResponse.json(json, { status });
}
