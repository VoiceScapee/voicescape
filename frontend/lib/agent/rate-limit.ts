/**
 * In-memory per-IP rate limit for the agent chat endpoint (20/hour).
 *
 * NOTE: this resets on server restart and is per-instance only. When the
 * Upstash REST pair lands, move this to the shared quota store so limits
 * hold across instances and deploys.
 */
import type { NextRequest } from "next/server";

export const AGENT_CHAT_RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const hits = new Map<string, number[]>();

/** Test hook: clear the in-memory rate-limit buckets. */
export function resetAgentChatRateLimit(): void {
  hits.clear();
}

export function agentChatClientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim() || "unknown";
  return "unknown";
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
