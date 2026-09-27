import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { readSocialActivity } from "@/lib/server/social-activity";

export const runtime = "nodejs";

/**
 * GET /api/social/activity → { ok, events: [{platform, summary, ts}] }
 *
 * Recent X/Discord bot posts, newest first — the real-data feed for the
 * X and Discord nodes on Danny's Vision. Returns an empty array (not an
 * error) until automation resumes; the page renders those nodes quiet.
 *
 * Read-only public data. No keys, no HBAR movement.
 */
export async function GET(req: NextRequest) {
  // Unattended polling: bound per-IP floods.
  const gated = await ipGate(
    req,
    "social-activity",
    "IP_RATE_LIMIT_SOCIAL_ACTIVITY",
    120,
    "too many requests from this network — try again in a moment",
  );
  if (gated) return gated;

  const events = await readSocialActivity(20);
  const res = NextResponse.json({ ok: true, events });
  res.headers.set(
    "Cache-Control",
    "public, s-maxage=30, stale-while-revalidate=120",
  );
  return res;
}
