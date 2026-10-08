/**
 * Pure helpers for the /console agent-console dashboard. Kept free of React
 * so they are trivially unit-testable.
 *
 * Money contract (mirrors the /api/agents schema): prices are INTEGER USD
 * cents (priceUsdCents). All formatting derives from that — never invent a
 * different unit.
 */

/** Username rule mirrored from the MCP surface (USERNAME_RE): lowercase, 3–32 chars. */
export const CONSOLE_USERNAME_RE = /^[a-z0-9_-]{3,32}$/;

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

export interface ConsoleAgentsQueryInput {
  capability?: string;
  maxPriceUsdCents?: number;
  limit?: number;
  /** When true, ask the directory for only agents flagged "open for work". */
  availableOnly?: boolean;
}

/**
 * Build the GET /api/agents URL for the given filters. Blank/invalid values
 * are omitted so the directory applies its defaults.
 */
export function buildConsoleAgentsQuery(
  input: ConsoleAgentsQueryInput,
): string {
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
  if (
    input.limit !== undefined &&
    Number.isFinite(input.limit) &&
    input.limit >= 0
  ) {
    params.set("limit", String(Math.floor(input.limit)));
  }
  if (input.availableOnly === true) {
    params.set("available", "true");
  }
  const qs = params.toString();
  return qs ? `/api/agents?${qs}` : "/api/agents";
}

/**
 * Build the GET /api/console/inbox URL for a username. Returns null when the
 * username fails the same rule the server enforces — the caller should show
 * the validation message instead of fetching.
 */
export function buildInboxQuery(username: string, limit: number): string | null {
  const name = username.trim().toLowerCase();
  if (!CONSOLE_USERNAME_RE.test(name)) return null;
  const n = Number.isFinite(limit)
    ? Math.max(1, Math.min(25, Math.floor(limit)))
    : 10;
  return `/api/console/inbox?username=${encodeURIComponent(name)}&limit=${n}`;
}

/**
 * Hedera consensus timestamp ("1699999999.123456789") -> a human-readable
 * local date/time string. Unparseable input passes through unchanged so the
 * raw value is never lost.
 */
export function formatConsensusTimestamp(ts: string): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(ts.trim());
  if (!m) return ts;
  const millis = Number(m[1]) * 1000 + Math.floor(Number(`0.${m[2] ?? "0"}`) * 1000);
  if (!Number.isFinite(millis)) return ts;
  try {
    return new Date(millis).toLocaleString();
  } catch {
    return ts;
  }
}

/** HashScan mainnet link for a topic id, or null for malformed input. */
export function hashscanTopicUrl(topicId: string): string | null {
  if (!/^0\.0\.\d+$/.test(topicId.trim())) return null;
  return `https://hashscan.io/mainnet/topic/${topicId.trim()}`;
}

/** HashScan mainnet link for an account (0.0.x) or EVM address, or null. */
export function hashscanAccountUrl(account: string): string | null {
  const a = account.trim();
  if (/^0\.0\.\d+$/.test(a) || /^0x[0-9a-fA-F]{40}$/.test(a)) {
    return `https://hashscan.io/mainnet/account/${a}`;
  }
  return null;
}

/** HashScan mainnet link for a contract id, or null for malformed input. */
export function hashscanContractUrl(contractId: string): string | null {
  if (!/^0\.0\.\d+$/.test(contractId.trim())) return null;
  return `https://hashscan.io/mainnet/contract/${contractId.trim()}`;
}

/**
 * HashScan mainnet link for a transaction id (0.0.x@seconds.nanos format),
 * or null for malformed input.
 */
export function hashscanTxUrl(txId: string): string | null {
  const t = txId.trim();
  if (!/^0\.0\.\d+@\d+\.\d+$/.test(t)) return null;
  return `https://hashscan.io/mainnet/transaction/${t}`;
}
