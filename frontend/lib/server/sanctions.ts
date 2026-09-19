/**
 * OFAC sanctions-screening plumbing (env-gated, DEFAULT OFF).
 *
 * Per OFAC's October 15, 2021 Sanctions Compliance Guidance for the
 * Virtual Currency Industry, sanctions compliance obligations apply to
 * virtual-currency transactions just as to traditional-currency ones —
 * "small and non-custodial" is not a shield. The compliance brief flags
 * this as the largest operational gap: today there is no geofencing, no
 * IP blocking, and no SDN-address screening on the dapp.
 *
 * This module is PLUMBING ONLY so counsel can scope and enable a
 * proportionate risk-based program without code changes later:
 *
 *   SANCTIONS_SCREENING_ENABLED=true   — master switch (default: off)
 *   SANCTIONS_BLOCKLIST_ADDRESSES      — comma-separated Hedera account
 *       ids (0.0.x) and/or EVM hex addresses known to be sanctioned
 *       (e.g. SDN-listed addresses). Empty by default.
 *
 * Semantics:
 *  - Disabled (default): screenAddress() always returns {allowed: true,
 *    screened: false}. NEVER blocks by default — nothing changes today.
 *  - Enabled: the wallet's canonical address is checked against the
 *    configured blocklist. Matches are blocked with a logged, auditable
 *    reason. When enabled but the blocklist is empty, screening is a
 *    no-op (fail-open with a loud boot warning) — counsel must provide
 *    the address list (or a screening provider) for this to do real work.
 *  - IP geoblocking of comprehensively sanctioned jurisdictions is NOT
 *    implemented here — that decision (jurisdictions, geolocation source,
 *    edge vs. app layer) belongs to counsel's program scoping. This
 *    module only covers the on-chain address check, and is not wired
 *    into any flow yet.
 *
 * When counsel scopes the program, the wiring point is a single guard in
 * the tip/purchase write paths calling screenAddress() — deliberately
 * left unwired until then.
 */

import { canonicalAddress } from "../session-message";

/** Master switch. Default OFF — never block by default. */
export function isSanctionsScreeningEnabled(): boolean {
  const raw = (process.env.SANCTIONS_SCREENING_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Configured blocklist, canonicalized (0.0.x → long-zero 0x; 0x… → lowercase). */
export function getSanctionsBlocklist(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of (process.env.SANCTIONS_BLOCKLIST_ADDRESSES ?? "").split(",")) {
    const c = canonicalAddress(raw.trim());
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

export interface ScreeningResult {
  /** Whether the transaction may proceed. */
  allowed: boolean;
  /** Whether screening actually ran (false when the flag is off). */
  screened: boolean;
  /** Human-readable reason (set when blocked, or when screening is a no-op). */
  reason?: string;
}

/**
 * Screen a wallet address against the configured sanctions blocklist.
 * Pure with respect to env config; reads no network or store.
 */
export function screenAddress(address: string): ScreeningResult {
  if (!isSanctionsScreeningEnabled()) {
    return { allowed: true, screened: false };
  }
  const canon = canonicalAddress(address);
  if (!canon) {
    return { allowed: false, screened: true, reason: "invalid wallet address" };
  }
  const blocklist = getSanctionsBlocklist();
  if (blocklist.length === 0) {
    console.warn(
      "[sanctions] screening enabled but SANCTIONS_BLOCKLIST_ADDRESSES is empty — no-op (fail-open). Provide a blocklist for real screening.",
    );
    return { allowed: true, screened: true, reason: "no blocklist configured" };
  }
  if (blocklist.includes(canon)) {
    console.warn(`[sanctions] BLOCKED sanctioned address ${canon}`);
    return { allowed: false, screened: true, reason: "address matches the sanctions blocklist" };
  }
  return { allowed: true, screened: true };
}
