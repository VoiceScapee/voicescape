import { NextRequest, NextResponse } from "next/server";
import { getKvStore } from "@/lib/server/store";
import { followerCount, USERNAME_RE } from "@/lib/follows";

export const runtime = "nodejs";

/**
 * GET /api/follows/count?username=<name> — public follower count for a
 * page (honest social proof: distinct wallets following it).
 * Response: { username, followers }
 */
export async function GET(req: NextRequest) {
  const name = (req.nextUrl.searchParams.get("username") ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(name)) {
    return NextResponse.json({ error: "invalid username" }, { status: 400 });
  }
  try {
    const followers = await followerCount(getKvStore(), name);
    return NextResponse.json({ username: name, followers });
  } catch (err) {
    console.error("[follows/count] failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "could not load the follower count" }, { status: 503 });
  }
}
