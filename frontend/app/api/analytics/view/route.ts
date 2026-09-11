import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import {
  normalizeLabel,
  normalizeSubject,
  normalizeUsername,
  recordPageView,
} from "@/lib/server/analytics";

export const runtime = "nodejs";

/**
 * POST /api/analytics/view
 * { username, subject?, label?, viewerAddress? }
 *
 * Fire-and-forget page-view tracking. Always answers 200 (fail-open) so a
 * tracking hiccup never breaks the page load. Views are rate-limited per
 * IP to prevent inflation; the page owner's own views are skipped when
 * the viewer is signed in as the owner.
 */
export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "analytics-view",
    "IP_RATE_LIMIT_ANALYTICS_VIEW",
    120,
    "too many view pings from this network — try again later",
  );
  if (gated) return gated;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  const b = (body ?? {}) as {
    username?: unknown;
    subject?: unknown;
    label?: unknown;
    viewerAddress?: unknown;
  };
  const username = normalizeUsername(b.username);
  if (!username) return NextResponse.json({ ok: true });

  // Skip the owner's own views (best-effort; never blocks recording).
  if (typeof b.viewerAddress === "string" && b.viewerAddress.trim()) {
    try {
      const { resolveUsernameWallet } = await import("@/lib/server/townhall/badges");
      const owner = await resolveUsernameWallet(username);
      if (owner && owner.toLowerCase() === b.viewerAddress.trim().toLowerCase()) {
        return NextResponse.json({ ok: true });
      }
    } catch {
      /* owner lookup failed — record the view anyway */
    }
  }

  try {
    await recordPageView(
      getKvStore(),
      username,
      normalizeSubject(b.subject),
      normalizeLabel(b.label),
    );
  } catch {
    /* analytics must never break the page */
  }
  return NextResponse.json({ ok: true });
}
