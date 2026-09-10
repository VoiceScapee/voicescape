/**
 * Pure helpers for the /agents/hire browse page. Kept free of React so they
 * are trivially unit-testable.
 *
 * Money contract (mirrors the /api/agents schema): prices are INTEGER USD
 * cents (priceUsdCents). All formatting derives from that — never invent a
 * different unit.
 */

import type { DirectoryAgent } from "@/lib/server/agents-directory";

/**
 * Case-insensitive membership check against the featured-agents list.
 * The list is off-chain and purely editorial — it never implies on-chain
 * status or verification.
 */
export function isFeaturedAgent(username: string, featuredUsernames: string[]): boolean {
  const normalized = username.trim().toLowerCase();
  if (!normalized) return false;
  return featuredUsernames.some(
    (u) => typeof u === "string" && u.trim().toLowerCase() === normalized,
  );
}

/**
 * Sort featured agents first, preserving original order within each group.
 * Non-array / empty input is a no-op — the directory ordering is untouched.
 */
export function sortFeaturedFirst(
  agents: DirectoryAgent[],
  featuredUsernames: string[],
): DirectoryAgent[] {
  if (!Array.isArray(featuredUsernames) || featuredUsernames.length === 0) {
    return [...agents];
  }
  const featured = agents.filter((a) => isFeaturedAgent(a.username, featuredUsernames));
  const rest = agents.filter((a) => !isFeaturedAgent(a.username, featuredUsernames));
  return [...featured, ...rest];
}

/** priceUsdCents -> "$x.xx". Non-finite/negative input degrades to "$0.00". */
export function formatUsdCents(priceUsdCents: number): string {
  const cents = Number.isFinite(priceUsdCents)
    ? Math.max(0, Math.floor(priceUsdCents))
    : 0;
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Parse a human-typed max price in dollars ("0.10") into integer USD cents.
 * Returns undefined for blank, non-numeric, or negative input so the caller
 * can omit the filter instead of sending a bogus value.
 */
export function parseMaxPriceUsdToCents(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n * 100);
}

/** "0x1234567890abcdef…" -> "0x1234…cdef". Short values pass through. */
export function truncateAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}\u2026${address.slice(-4)}`;
}

export interface AgentsQueryInput {
  capability?: string;
  maxPriceUsdCents?: number;
  limit?: number;
}

/**
 * Build the /api/agents URL for the given filters. Blank/invalid values are
 * omitted so the directory applies its defaults.
 */
export function buildAgentsQuery(input: AgentsQueryInput): string {
  const params = new URLSearchParams();
  const capability = input.capability?.trim();
  if (capability) params.set("capability", capability);
  if (
    input.maxPriceUsdCents !== undefined &&
    Number.isFinite(input.maxPriceUsdCents) &&
    input.maxPriceUsdCents >= 0
  ) {
    params.set("maxPriceUsdCents", String(Math.floor(input.maxPriceUsdCents)));
  }
  if (input.limit !== undefined && Number.isFinite(input.limit) && input.limit >= 0) {
    params.set("limit", String(Math.floor(input.limit)));
  }
  const qs = params.toString();
  return qs ? `/api/agents?${qs}` : "/api/agents";
}
