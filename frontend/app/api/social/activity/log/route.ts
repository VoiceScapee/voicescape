import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { ipGate } from "@/lib/server/rate-limit";
import { logSocialPost } from "@/lib/server/social-activity";

export const runtime = "nodejs";

/**
 * POST /api/social/activity/log — the dapp-side producer pipe for the
 * social activity feed.
 *
 * Body: { platform: "x" | "discord", summary: string, ts?: string }
 *   - platform: which surface the post went out on.
 *   - summary: short internal note (max 300 chars). Server-side ONLY —
 *     the public GET /api/social/activity never serves it (Brandon's
 *     rule: no X/Discord post text ever leaves the server).
 *   - ts: optional ISO timestamp of when the post was confirmed live.
 *     Must parse as a date, must not be more than 5 minutes in the
 *     future, and must not be older than 7 days (the store's TTL).
 *     When omitted, the server stamps arrival time.
 *
 * Auth: server-to-server shared token. `Authorization: Bearer
 * <SOCIAL_LOG_TOKEN>`. Fail closed: 401 when the env var is unset or
 * the token does not match (constant-time comparison, same pattern as
 * the MCP operator auth).
 *
 * Callers: the real posting paths (Discord bot, X automation) call this
 * AFTER the post is confirmed live — never for scheduled, queued, or
 * failed posts. Logging-only: the endpoint records; it never posts
 * anything itself.
 *
 * 201 → { ok: true } — the event was recorded.
 * 400 → invalid body. 401 → missing/bad token. 429 → rate limited.
 */
const MAX_SUMMARY_CHARS = 300;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function checkLogAuth(headers: Headers): boolean {
  const expected = process.env.SOCIAL_LOG_TOKEN;
  if (!expected) return false;
  const auth = headers.get("authorization");
  if (!auth) return false;
  const m = /^Bearer (.+)$/.exec(auth.trim());
  if (!m) return false;
  const a = createHash("sha256").update(m[1], "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Server-to-server producers: bound per-IP floods.
  const gated = await ipGate(
    req,
    "social-activity-log",
    "IP_RATE_LIMIT_SOCIAL_ACTIVITY_LOG",
    60,
    "too many requests from this network — try again in a moment",
  );
  if (gated) return gated;

  if (!checkLogAuth(req.headers)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("request body must be JSON");
  }
  if (!body || typeof body !== "object") {
    return badRequest("request body must be an object");
  }
  const { platform, summary, ts } = body as Record<string, unknown>;

  if (platform !== "x" && platform !== "discord") {
    return badRequest('platform must be "x" or "discord"');
  }
  if (typeof summary !== "string" || summary.length === 0) {
    return badRequest("summary must be a non-empty string");
  }
  if (summary.length > MAX_SUMMARY_CHARS) {
    return badRequest(
      `summary must be at most ${MAX_SUMMARY_CHARS} characters`,
    );
  }

  // Optional client timestamp — validated so the feed can't be backfilled
  // with ancient history or future-dated.
  let eventTs: string | undefined;
  if (ts !== undefined) {
    if (typeof ts !== "string") {
      return badRequest("ts must be an ISO date string");
    }
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) {
      return badRequest("ts must be a valid ISO date string");
    }
    const now = Date.now();
    if (ms > now + MAX_FUTURE_SKEW_MS) {
      return badRequest("ts must not be in the future");
    }
    if (now - ms > MAX_AGE_MS) {
      return badRequest("ts is older than the 7-day retention window");
    }
    eventTs = new Date(ms).toISOString();
  }

  // Recording-only: never posts anything itself. Store failure rejects
  // and the caller decides whether that matters (the post already went
  // out — logging must never break posting).
  await logSocialPost(platform, summary, eventTs);
  return NextResponse.json({ ok: true }, { status: 201 });
}
