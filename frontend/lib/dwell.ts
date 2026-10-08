/**
 * Client-side dwell-time telemetry for the tip flow.
 *
 * Pairs with POST /api/metrics/dwell. The server stamps T1/T2 on its own
 * clock — this helper only shuttles the flow id + challenge nonce and the
 * mirror-node consensus timestamp for T3.
 *
 * Fire-and-forget, never throws, never retries: telemetry can never
 * affect the paid action it measures. If the open call hasn't resolved
 * (or failed) by sign time, later events are silently dropped — the
 * flow degrades to the existing aggregate counters.
 */

import type { ConversionContext } from "@/lib/server/conversion";

const ENDPOINT = "/api/metrics/dwell";
const COHORT_KEY = "vs_dwell_cohort";

interface DwellSession {
  flowId: string;
  nonce: string;
}

let session: DwellSession | null = null;

/**
 * Anonymous cohort key for repeat-flow stability analysis. A random UUID
 * generated once per browser, kept in localStorage, never joined with
 * wallet/IP/identity. Clearing site data rotates it. Best-effort: if
 * storage is unavailable the flow still works, just ungrouped.
 */
function readCohort(): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    let cohort = window.localStorage.getItem(COHORT_KEY);
    if (!cohort) {
      cohort =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `dwell-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      window.localStorage.setItem(COHORT_KEY, cohort);
    }
    return cohort;
  } catch {
    return null;
  }
}

async function post(payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Tip flow opened — T1 is stamped server-side on receipt. */
export async function dwellFlowOpen(context?: ConversionContext): Promise<void> {
  session = null;
  try {
    const data = await post({ action: "flow_open", context, cohort: readCohort() });
    if (data && typeof data.flowId === "string" && typeof data.nonce === "string") {
      session = { flowId: data.flowId, nonce: data.nonce };
    }
  } catch {
    /* telemetry never throws */
  }
}

/** Wallet signature submitted — T2 is stamped server-side on receipt. */
export function dwellSignSubmit(): void {
  const s = session;
  if (!s) return;
  void post({ action: "sign_submit", flowId: s.flowId, nonce: s.nonce });
}

/**
 * Tip confirmed on-chain — t3Ms is the mirror-node consensus timestamp
 * in epoch ms (network time, not the device clock). Runs server-side
 * monotonicity + bounds validation.
 */
export function dwellSettled(t3Ms: number | null): void {
  const s = session;
  if (!s || t3Ms == null) return;
  void post({ action: "settled", flowId: s.flowId, nonce: s.nonce, t3: t3Ms });
}

/** Clear the current flow (modal closed / reset for another tip). */
export function dwellReset(): void {
  session = null;
}
