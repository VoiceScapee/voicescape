/**
 * Voicescape Social Town Hall — topic + network config from env.
 *
 * One topic per domain: forum, chat, votes, polls, market.
 *
 * NOTE: the polls topic's internal domain key is still "governance"
 * (TOPIC_ENV below maps it to TOWNHALL_TOPIC_GOV). That string is config
 * wiring, not an HCS wire value — HCS message kinds here are "proposal"
 * and "proposal-vote", and the topic is identified on the network by its
 * Hedera id. Kept as-is so existing deployments don't need env changes.
 */

export type TownhallNetwork = "testnet" | "mainnet" | "previewnet";

export type TopicDomain = "forum" | "chat" | "votes" | "governance" | "market";

const TOPIC_ENV: Record<TopicDomain, string> = {
  forum: "TOWNHALL_TOPIC_FORUM",
  chat: "TOWNHALL_TOPIC_CHAT",
  votes: "TOWNHALL_TOPIC_VOTES",
  governance: "TOWNHALL_TOPIC_GOV",
  market: "TOWNHALL_TOPIC_MARKET",
};

export function townhallNetwork(): TownhallNetwork {
  const raw = (process.env.TOWNHALL_HCS_NETWORK ?? "testnet").toLowerCase();
  if (raw === "mainnet" || raw === "previewnet" || raw === "testnet") return raw;
  return "testnet";
}

/**
 * Fail-loud boot check: TOWNHALL_HCS_NETWORK silently defaults to testnet
 * when unset or invalid, which breaks every Town Hall write in production.
 * The default is unchanged — this just makes the misconfiguration loud in
 * server logs at startup so it can't go unnoticed.
 */
if (typeof process !== "undefined" && process.env.TOWNHALL_HCS_NETWORK === undefined) {
  // eslint-disable-next-line no-console
  console.error(
    "[townhall] TOWNHALL_HCS_NETWORK is not set — defaulting to testnet. " +
      "Set TOWNHALL_HCS_NETWORK=mainnet in production or all Town Hall writes will target testnet.",
  );
} else if (typeof process !== "undefined") {
  const rawCheck = String(process.env.TOWNHALL_HCS_NETWORK).toLowerCase();
  if (rawCheck !== "mainnet" && rawCheck !== "testnet" && rawCheck !== "previewnet") {
    // eslint-disable-next-line no-console
    console.error(
      `[townhall] TOWNHALL_HCS_NETWORK="${process.env.TOWNHALL_HCS_NETWORK}" is invalid — ` +
        "defaulting to testnet. Use mainnet, testnet, or previewnet.",
    );
  }
}

/** Hedera mirror node REST base URL for the Town Hall network. */
export function mirrorBaseUrl(): string {
  switch (townhallNetwork()) {
    case "mainnet":
      return "https://mainnet.mirrornode.hedera.com";
    case "previewnet":
      return "https://previewnet.mirrornode.hedera.com";
    default:
      return "https://testnet.mirrornode.hedera.com";
  }
}

/** Topic id for a domain, or null when not configured. */
export function getTopicId(domain: TopicDomain): string | null {
  const id = process.env[TOPIC_ENV[domain]];
  return id && id.trim() ? id.trim() : null;
}

/** True when all five Town Hall topics are configured. */
export function topicsConfigured(): boolean {
  return (Object.keys(TOPIC_ENV) as TopicDomain[]).every((d) => getTopicId(d) !== null);
}

/**
 * Dust fee, in tinybars. Default 2,000,000 tinybars = 0.02 HBAR ≈ $0.004
 * at ~$0.20/HBAR — real per-write spam friction, still cheap. Configurable
 * via DUST_FEE_TINYBARS.
 */
export function dustFeeTinybars(): number {
  const raw = process.env.DUST_FEE_TINYBARS;
  if (raw && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return 2_000_000;
}

/** Treasury address receiving dust fees (NEXT_PUBLIC_TREASURY_ADDRESS). */
export function treasuryAddress(): string | null {
  const addr = process.env.NEXT_PUBLIC_TREASURY_ADDRESS;
  return addr && addr.trim() ? addr.trim() : null;
}
