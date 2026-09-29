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
import { getTreasuryId } from "@/lib/contracts";

export type TownhallNetwork = "mainnet";

export type TopicDomain = "forum" | "chat" | "votes" | "governance" | "market";

const TOPIC_ENV: Record<TopicDomain, string> = {
  forum: "TOWNHALL_TOPIC_FORUM",
  chat: "TOWNHALL_TOPIC_CHAT",
  votes: "TOWNHALL_TOPIC_VOTES",
  governance: "TOWNHALL_TOPIC_GOV",
  market: "TOWNHALL_TOPIC_MARKET",
};

/** Town Hall network — mainnet only, no testnet (Brandon's rule 2026-09-28). */
export function townhallNetwork(): TownhallNetwork {
  return "mainnet";
}

/** Hedera mirror node REST base URL for the Town Hall network (mainnet). */
export function mirrorBaseUrl(): string {
  return "https://mainnet.mirrornode.hedera.com";
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

/** Treasury address receiving dust fees. Falls back to mainnet default. */
export function treasuryAddress(): string | null {
  return getTreasuryId();
}
