import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { readSocialActivity } from "@/lib/server/social-activity";

export const runtime = "nodejs";

/**
 * GET /api/social/activity → { ok, events: [{platform, ts}] }
 *
 * Recent X/Discord bot activity signal, newest first — the real-data feed
 * for the X and Discord nodes on Danny's Vision. Returns an empty array
 * (not an error) until automation resumes; the page renders those nodes
 * quiet.
 *
 * The public contract is a CONTENT-FREE signal: platform + timestamp only.
 * Summaries stay server-side and are never served — Brandon's rule: no X /
 * Discord post text, captions, messages, or previews ever leave the server.
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
  // Content-free public signal: platform + timestamp only. The summary
  // stays server-side — it is never part of the public contract.
  const publicEvents = events.map(({ platform, ts }) => ({ platform, ts }));
  const res = NextResponse.json({ ok: true, events: publicEvents });
  res.headers.set(
    "Cache-Control",
    "public, s-maxage=30, stale-while-revalidate=120",
  );
  return res;
}
