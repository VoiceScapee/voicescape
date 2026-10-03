/**
 * POST /api/usage — internal usage telemetry ingestion.
 *
 * Body: { event: UsageEvent, context?: { detail?, sid? }, preview?: object }
 * - event must be in the allowlist (usage-telemetry.ts)
 * - preview must be a plain JSON object ≤ 60KB (builder draft page snapshot)
 * - generous per-IP rate limit; telemetry never blocks UI (client drops failures)
 * - stores aggregate counters + anonymous samples; no wallets/IPs/usernames
 */

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { checkIpRateLimit, clientIpFromHeaders } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import {
  createUsageStore,
  dayKey,
  isUsageEvent,
  scrubContext,
} from "@/lib/server/usage-telemetry";
import { scrubErrorMessage } from "@/lib/server/client-errors";

/** Scrub free-text detail of identifiers before storage (no PII in telemetry). */
function scrubDetail(detail: unknown): string | undefined {
  if (typeof detail !== "string" || detail.length === 0) return undefined;
  return scrubErrorMessage(detail).slice(0, 120) || undefined;
}

const USAGE_IP_LIMIT = 120;
const USAGE_IP_WINDOW_MS = 3_600_000;
const MAX_PREVIEW_BYTES = 60_000;

/** A builder draft page snapshot: plain object, bounded size. */
function validPreview(p: unknown): boolean {
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  try {
    return JSON.stringify(p).length <= MAX_PREVIEW_BYTES;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let rl;
  try {
    rl = await checkIpRateLimit(
      clientIpFromHeaders(req.headers),
      "usage",
      USAGE_IP_LIMIT,
      USAGE_IP_WINDOW_MS,
    );
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  if (!rl.allowed) return NextResponse.json({ ok: false }, { status: 429 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  if (!isUsageEvent(b.event)) return NextResponse.json({ ok: false }, { status: 400 });
  const ctx = scrubContext(b.context);
  // Scrub any free-text detail (e.g. publish failure reasons) of
  // identifiers before it touches storage.
  if (ctx.detail) {
    const clean = scrubDetail(ctx.detail);
    if (clean) ctx.detail = clean;
    else delete ctx.detail;
  }

  const store = createUsageStore(getKvStore());
  const now = Date.now();
  try {
    await store.incrCount(b.event, dayKey());
    await store.pushSample({ event: b.event, ...ctx, at: now });
    if (b.preview !== undefined) {
      if (!validPreview(b.preview)) return NextResponse.json({ ok: false }, { status: 400 });
      await store.pushPreview(b.preview, now);
    }
  } catch {
    // Telemetry storage failure is invisible to the user.
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: true });
}
