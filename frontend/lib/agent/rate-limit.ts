/**
 * In-memory per-IP rate limit for the agent chat endpoint (20/hour).
 *
 * NOTE: this resets on server restart and is per-instance only. When the
 * Upstash REST pair lands, move this to the shared quota store so limits
 * hold across instances and deploys.
 */
import type { NextRequest } from "next/server";
import { clientIpFromHeaders } from "../server/rate-limit";

export const AGENT_CHAT_RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const hits = new Map<string, number[]>();

/** Test hook: clear the in-memory rate-limit buckets. */
export function resetAgentChatRateLimit(): void {
  hits.clear();
}

export function agentChatClientIp(req: NextRequest): string {
  // Trust order: x-vercel-forwarded-for, then the LAST x-forwarded-for
  // entry (appended by the edge), then x-real-ip. Never the FIRST entry:
  // it is attacker-controlled and spoofing it used to mint a fresh
  // 20/hour budget per request.
  return clientIpFromHeaders(req.headers);
}

/** Returns true when the IP has exceeded its hourly budget. */
export function agentChatRateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (bucket.length >= AGENT_CHAT_RATE_LIMIT) {
    hits.set(ip, bucket);
    return true;
  }
  bucket.push(now);
  hits.set(ip, bucket);
  return false;
}

// ---------------------------------------------------------------------------
// Build-credit status checks (GET /api/agent/chat/build-credit).
// ---------------------------------------------------------------------------

/**
 * Separate, roomier budget from chat: the widget polls this after the
 * visitor pays (mirror-node discovery lags), so it must not eat the
 * chat message budget.
 */
export const BUILD_CREDIT_RATE_LIMIT = 60;
const creditHits = new Map<string, number[]>();

/** Test hook: clear the build-credit rate-limit buckets. */
export function resetBuildCreditRateLimit(): void {
  creditHits.clear();
}

/** Returns true when the IP has exceeded its hourly build-credit budget. */
export function buildCreditRateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = (creditHits.get(ip) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS
  );
  if (bucket.length >= BUILD_CREDIT_RATE_LIMIT) {
    creditHits.set(ip, bucket);
    return true;
  }
  bucket.push(now);
  creditHits.set(ip, bucket);
  return false;
}
