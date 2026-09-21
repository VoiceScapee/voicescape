import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { annotateFeed, isGodseyeAgent, readLiveFeed } from "@/lib/server/godseye";

export const runtime = "nodejs";

/**
 * GET /api/agents/[agent]/feed
 *
 * God's Eye View public feed. Serves the sanitized snapshot the VM
 * collector publishes — live from the public gist (~5 min refresh), with
 * the bundled frontend/data/feeds/<agent>.json as fallback. The page polls
 * this roughly every 45s. The collector is the privacy firewall; this route
 * only reads, computes staleness (the dead-man's switch), and caches.
 *
 * 200 → { ok, v, agent, generatedAt, updatedAgoSec, stale, systems, now,
 *          events, queue }
 * 404 → { ok: false, error } for unknown agents or an unpublished feed
 *        (the honest empty state — never a fabricated feed).
 * 429 → per-IP flood bound.
 *
 * Read-only public data. No keys, no HBAR movement.
 */
export async function GET(req: NextRequest, { params }: { params: { agent: string } }) {
  // Feed polls are unattended: bound per-IP floods. 120/min leaves wide
  // headroom for ~45s polling across tabs.
  const gated = await ipGate(
    req,
    "godseye-feed",
    "IP_RATE_LIMIT_GODSEYE_FEED",
    120,
    "too many feed requests from this network — try again in a moment",
  );
  if (gated) return gated;

  const agent = params.agent ?? "";
  if (!isGodseyeAgent(agent)) {
    return NextResponse.json({ ok: false, error: "unknown agent" }, { status: 404 });
  }
  const feed = await readLiveFeed(agent);
  if (!feed) {
    return NextResponse.json(
      { ok: false, agent, error: "feed not published yet" },
      { status: 404 },
    );
  }
  const res = NextResponse.json({ ok: true, ...annotateFeed(feed) });
  res.headers.set("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  return res;
}
