/**
 * Voicescape — per-IP fixed-window rate limiting, backed by the shared store.
 *
 * This is the SECOND bound in front of the per-wallet quotas: it stops one
 * IP (one machine, one NAT, one botnet node) from multiplying per-wallet
 * quotas across many funded wallets. It is not full Sybil resistance —
 * nothing free is — but it raises the cost of quota-multiplication from
 * "one funded wallet" to "one funded wallet per IP per window", and the
 * residual risk + operator levers are documented in COST_ZERO.md.
 *
 * Implementation: fixed windows over the shared KvStore. The window epoch
 * is part of the key, so a missing TTL can never leak one window's count
 * into the next. When the store is unreachable the check FAILS CLOSED
 * (503): an unchecked flood gate must not silently become unlimited.
 * Requests with no discernible IP share the "unknown" bucket (the
 * conservative direction).
 *
 * NOTE: this module imports next/server — it is for route handlers, not
 * for the Next-free handler/test layer (which uses checkIpRateLimit
 * directly).
 */

import { NextResponse } from "next/server";
import { getKvStore } from "./store";
import { quotaLimitFromEnv } from "./quota";

export interface IpRateLimitResult {
  allowed: boolean;
  /** Requests seen from this IP in the current window (includes this one). */
  used: number;
  limit: number;
  /** ms until the current window ends. */
  retryAfterMs: number;
}

function sanitizeIp(ip: string): string {
  const clean = ip.trim().toLowerCase().slice(0, 64);
  if (!clean) return "unknown";
  // IPv4/IPv6 chars only; anything else collapses to the unknown bucket.
  return /^[0-9a-f.:]+$/.test(clean) ? clean : "unknown";
}

/**
 * Best-effort client IP.
 *
 * Header trust order:
 * 1. `x-vercel-forwarded-for` — set by the Vercel edge itself, so it is the
 *    most trustworthy source on Vercel deployments.
 * 2. The LAST `x-forwarded-for` entry — each proxy appends to the list, so
 *    the last entry is the one added closest to our server (the Vercel edge
 *    appending the real client IP). The FIRST entry is attacker-controlled
 *    and must not be trusted: spoofing it used to give every IP flood gate
 *    a fresh bucket.
 * 3. `x-real-ip` (for a self-hosted operator's own proxy).
 */
export function clientIpFromHeaders(headers: Headers): string {
  const vercel = headers.get("x-vercel-forwarded-for");
  if (vercel) {
    const first = vercel.split(",")[0]?.trim();
    if (first) return sanitizeIp(first);
  }
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const entries = xff
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    const last = entries[entries.length - 1];
    if (last) return sanitizeIp(last);
  }
  const real = headers.get("x-real-ip");
  if (real) return sanitizeIp(real);
  return "unknown";
}

export function ipRateLimitFromEnv(
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
): number {
  return quotaLimitFromEnv(name, fallback, env);
}

export function ipRateLimitWindowMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return quotaLimitFromEnv("IP_RATE_LIMIT_WINDOW_MS", 3_600_000, env);
}

/**
 * Fixed-window per-IP check. Throws when the store is unreachable (the
 * caller converts to 503 — fail closed).
 */
export async function checkIpRateLimit(
  ip: string,
  bucket: string,
  limit: number,
  windowMs: number,
  nowMs: number = Date.now(),
): Promise<IpRateLimitResult> {
  const cleanIp = sanitizeIp(ip);
  const windowEpoch = Math.floor(nowMs / windowMs);
  const key = `vs:iprl:${bucket}:${cleanIp}:${windowEpoch}`;
  const used = await getKvStore().incr(key, windowMs);
  const windowEndMs = (windowEpoch + 1) * windowMs;
  return {
    allowed: used <= limit,
    used,
    limit,
    retryAfterMs: Math.max(0, windowEndMs - nowMs),
  };
}

/** 429 JSON body for IP rate-limit hits. */
export function ipRateLimitBody(result: IpRateLimitResult, message: string): Record<string, unknown> {
  return {
    error: message,
    limit: result.limit,
    retryAfterMs: result.retryAfterMs,
  };
}

/**
 * Route-level IP gate: returns a 429 NextResponse when the caller's IP
 * exhausted its window, a 503 when the store is unreachable (fail
 * closed), or null when the request may proceed. Cheap — call it before
 * any authenticated/paid work.
 */
export async function ipGate(
  req: { headers: Headers },
  bucket: string,
  envName: string,
  defaultLimit: number,
  message: string,
): Promise<NextResponse | null> {
  const limit = ipRateLimitFromEnv(envName, defaultLimit);
  const windowMs = ipRateLimitWindowMs();
  let res: IpRateLimitResult;
  try {
    res = await checkIpRateLimit(clientIpFromHeaders(req.headers), bucket, limit, windowMs);
  } catch (e) {
    console.error(`[rate-limit] store unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json(
      { error: "temporarily unavailable — please retry in a moment" },
      { status: 503 },
    );
  }
  if (!res.allowed) {
    return NextResponse.json(ipRateLimitBody(res, message), { status: 429 });
  }
  return null;
}
