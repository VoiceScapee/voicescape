/**
 * Client-side usage telemetry — internal only, founder eyes.
 *
 * Fire-and-forget POST to /api/usage with an allowlisted event name and
 * coarse context. Never throws, never retries, never blocks UI.
 * No wallets, IPs, usernames, or message text are ever sent — see
 * lib/server/usage-telemetry.ts for the full privacy contract.
 */
import type { UsageContext, UsageEvent } from "@/lib/server/usage-telemetry";

export type { UsageContext, UsageEvent };

const ENDPOINT = "/api/usage";

/** Anonymous per-page-load id for sequencing a session's events. */
let sid: string | null = null;
export function usageSid(): string {
  if (!sid) {
    sid =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
  }
  return sid;
}

export function recordUsageEvent(
  event: UsageEvent,
  context?: Omit<UsageContext, "sid">,
  preview?: unknown,
): void {
  try {
    const payload = JSON.stringify({
      event,
      context: { ...context, sid: usageSid() },
      ...(preview !== undefined ? { preview } : {}),
    });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function" && preview === undefined) {
      // sendBeacon can't carry large payloads reliably — use fetch for snapshots.
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
