/**
 * AI crawler tracker — server-side observation of AI systems checking
 * Voicescape. The existing analytics is client-side (browsers phone
 * home), so crawlers are invisible to it; this middleware closes that
 * gap at the server, where every request is seen.
 *
 * FAIL-OPEN, ALWAYS. Every tracker step is wrapped so a failure — no
 * env vars, store down, an unexpected runtime — can never break, delay,
 * or alter a visitor's response. Recording runs AFTER the response via
 * Next's after(), so it adds zero latency to the response path; if
 * after() is unavailable in this runtime, the write still fires
 * best-effort without being awaited.
 *
 * Privacy: only the canonical bot name + path + UTC day are recorded.
 * Never IPs, never raw User-Agent strings, never cookies, never human
 * page views (see lib/crawlers.ts for the exact record/skip rules).
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { after } from "next/server";
import { dayKey, shouldRecord } from "./lib/crawlers";
import { recordCrawlerHit } from "./lib/crawlers-store";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

export function middleware(req: NextRequest): NextResponse {
  const res = NextResponse.next();
  try {
    const signal = shouldRecord(
      req.headers.get("user-agent"),
      req.nextUrl.pathname,
    );
    if (!signal) return res;
    const day = dayKey();
    const run = async (): Promise<void> => {
      try {
        await recordCrawlerHit(signal, day);
      } catch {
        // Fail-open: a lost hit is acceptable; a broken response is not.
      }
    };
    try {
      after(run);
    } catch {
      // after() unavailable here — best-effort floating write instead.
      void run().catch(() => {});
    }
  } catch {
    // Never let tracker work break a visitor's response.
  }
  return res;
}
