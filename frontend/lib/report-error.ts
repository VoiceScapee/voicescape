/**
 * Client-side reporting for HANDLED errors — the ones a catch block shows
 * to the user (failed tip, failed publish, sign-in failure, …).
 *
 * The global hook in app/providers.tsx only sees UNCAUGHT errors; a failed
 * tip records its funnel count but the *reason* died in the user's browser.
 * Call reportError(e, "<component>") from every catch block that surfaces
 * an error so reasons flow into /api/client-error → /admin/errors → the
 * engine's morning intake.
 *
 * Privacy: same rules as the global hook — message only (max 200 chars,
 * scrubbed of wallet addresses / account IDs), first stack frame only,
 * pathname only (no query strings), an optional component tag. Never sent:
 * full stack traces, full URLs, IPs, user agents, wallet addresses.
 *
 * Delivery is fire-and-forget via navigator.sendBeacon with a keepalive
 * fetch fallback. This function never throws and never retries — a failure
 * to report is silently dropped so telemetry can never cause an error
 * loop. At most 10 unique reports per page load.
 */
import { firstStackFrame } from "@/lib/client-error-frame";

const ENDPOINT = "/api/client-error";
const MAX_UNIQUE_PER_LOAD = 10;
const MAX_MESSAGE_CHARS = 200;

const seen = new Set<string>();

function scrub(s: string): string {
  return s
    .replace(/0x[a-fA-F0-9]{8,}/g, "0x…")
    .replace(/\b\d{1,10}\.\d{1,10}\.\d{1,10}\b/g, "0.0.…");
}

/**
 * Report a handled error. `error` may be anything a catch block caught;
 * `component` is a short tag like "tip-modal", "builder-publish",
 * "sign-in", "wallet-connect".
 */
export function reportError(error: unknown, component: string): void {
  try {
    const raw =
      error instanceof Error && error.message
        ? error.message
        : typeof error === "string" && error
          ? error
          : "unknown error";
    const msg = scrub(raw).trim().replace(/\s+/g, " ").slice(0, MAX_MESSAGE_CHARS);
    if (!msg) return;
    if (typeof window === "undefined") return;
    // Pathname only — strip query string and fragment (can carry PII).
    const page = (window.location.pathname || "/").split("?")[0].split("#")[0] || "/";
    const frame = error instanceof Error ? firstStackFrame(error.stack) : null;
    const key = `${page}|${component}|${msg}|${frame ?? ""}`;
    if (seen.has(key) || seen.size >= MAX_UNIQUE_PER_LOAD) return;
    seen.add(key);
    const payload = JSON.stringify({
      message: msg,
      page,
      component,
      ...(frame ? { frame } : {}),
    });
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
    /* reporting must never throw */
  }
}

/** Test hook: reset the per-load dedup set. */
export function __resetReportErrorSeenForTests(): void {
  seen.clear();
}
