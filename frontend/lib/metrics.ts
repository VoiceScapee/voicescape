/**
 * Client-side conversion telemetry.
 *
 * Fire-and-forget POST to /api/metrics with an allowlisted event name and
 * an optional coarse surface context ("blockpage" | "post" for tip events).
 * The server stores aggregate daily counters only — no wallet, IP, specific
 * page, or tx id. This function never throws and never retries: telemetry
 * can never affect the paid action it measures.
 */
import type { ConversionContext, ConversionEvent } from "@/lib/server/conversion";

/** Re-exported so call sites don't import server code directly. */
export type { ConversionContext, ConversionEvent };

const ENDPOINT = "/api/metrics";

export function recordConversionEvent(
  event: ConversionEvent,
  context?: ConversionContext,
): void {
  try {
    const payload = JSON.stringify({ event, context });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: "application/json" }));
    } else {
      void fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {
        /* telemetry failure is silently dropped */
      });
    }
  } catch {
    /* telemetry must never throw */
  }
}
