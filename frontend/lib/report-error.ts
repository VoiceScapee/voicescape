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
 * pathname only (no query strings), an optional component tag, the error
 * name, the action being attempted, and the wallet-connection state at the
 * time (connected/disconnected/connecting — never an address). Never sent:
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
const MAX_OBJECT_DUMP_CHARS = 120;

const seen = new Set<string>();

function scrub(s: string): string {
  return s
    .replace(/0x[a-fA-F0-9]{8,}/g, "0x…")
    .replace(/\b\d{1,10}\.\d{1,10}\.\d{1,10}\b/g, "0.0.…");
}

/** Safely stringify a thrown object (circular refs are common). */
function safeDump(value: object): string | null {
  try {
    const json = JSON.stringify(value);
    if (!json || json === "{}") return null;
    return json.slice(0, MAX_OBJECT_DUMP_CHARS);
  } catch {
    return null;
  }
}

export interface ExtractedError {
  message: string;
  /** Error name ("TypeError", "UserRejected", …) when one is available. */
  name: string | null;
}

/**
 * Extract a human-readable message (and name) from ANY thrown value.
 *
 * The old code recorded "unknown error" for everything that wasn't an
 * Error instance or a non-empty string — which is exactly how
 * WalletConnect's plain-object rejections ({ code, message }) and Errors
 * with empty messages became invisible. Every branch below produces the
 * most specific message available instead of giving up.
 */
export function extractErrorDetails(error: unknown): ExtractedError {
  if (error instanceof Error) {
    const name = typeof error.name === "string" && error.name ? error.name : null;
    if (error.message) return { message: error.message, name };
    // An Error with an empty message still tells us its class.
    return { message: name ? `${name} (no message)` : "Error (no message)", name };
  }
  if (typeof error === "string") {
    return { message: error || "(empty string thrown)", name: null };
  }
  if (error === null) return { message: "thrown null", name: null };
  if (error === undefined) return { message: "thrown undefined", name: null };
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return { message: `thrown ${String(error)}`, name: null };
  }
  if (typeof error === "object") {
    const o = error as Record<string, unknown>;
    const name = typeof o.name === "string" && o.name ? o.name : null;
    const msg = typeof o.message === "string" && o.message ? o.message : null;
    const code = typeof o.code === "number" || typeof o.code === "string" ? String(o.code) : null;
    if (msg) {
      return { message: code ? `${msg} (code ${code})` : msg, name };
    }
    if (code) {
      return { message: name ? `${name} (code ${code})` : `thrown object (code ${code})`, name };
    }
    const dump = safeDump(o);
    if (dump) return { message: `thrown object ${dump}`, name };
    return { message: name ? `thrown ${name}` : "thrown object", name };
  }
  return { message: `thrown ${typeof error}`, name: null };
}

/** Wallet-connection state at the moment of the error — never an address. */
export type WalletReportState = "connected" | "disconnected" | "connecting";

export interface ReportErrorOpts {
  /** What the user/app was attempting, e.g. "tip-submit", "pair-wallet". */
  action?: string;
  /** Wallet-connection state at the time — never an address. */
  walletState?: WalletReportState;
}

/**
 * Report a handled error. `error` may be anything a catch block caught;
 * `component` is a short tag like "tip-modal", "builder-publish",
 * "sign-in", "wallet-connect". `opts.action` names the attempted action
 * and `opts.walletState` records whether a wallet was connected —
 * both are optional so old call sites keep working.
 */
export function reportError(error: unknown, component: string, opts?: ReportErrorOpts): void {
  try {
    const { message: raw, name } = extractErrorDetails(error);
    const msg = scrub(raw).trim().replace(/\s+/g, " ").slice(0, MAX_MESSAGE_CHARS);
    if (!msg) return;
    if (typeof window === "undefined") return;
    // Pathname only — strip query string and fragment (can carry PII).
    const page = (window.location.pathname || "/").split("?")[0].split("#")[0] || "/";
    const frame = error instanceof Error ? firstStackFrame(error.stack) : null;
    const action = opts?.action?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40) || null;
    const walletState =
      opts?.walletState === "connected" ||
      opts?.walletState === "disconnected" ||
      opts?.walletState === "connecting"
        ? opts.walletState
        : null;
    const key = `${page}|${component}|${action ?? ""}|${walletState ?? ""}|${msg}|${frame ?? ""}`;
    if (seen.has(key) || seen.size >= MAX_UNIQUE_PER_LOAD) return;
    seen.add(key);
    const payload = JSON.stringify({
      message: msg,
      page,
      component,
      ...(name ? { name } : {}),
      ...(action ? { action } : {}),
      ...(walletState ? { walletState } : {}),
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
