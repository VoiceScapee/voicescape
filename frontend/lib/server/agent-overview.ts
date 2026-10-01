/**
 * agent-overview — the owner's mission-control snapshot for their AI
 * agent's blockpage.
 *
 * Sections (Brandon's spec — status, activity, approvals, nothing else):
 *   status   — is the agent's page registered on-chain (lookup_blockpage),
 *              and does its profile actually load (check_profile_pin).
 *   activity — recent on-chain tips to the agent's page (TipSent logs).
 *   (proposals live in the /api/agents/proposals inbox — the chat polls
 *   that separately so approvals stay snappy.)
 *
 * All data is read live from Hedera mainnet (official mirror node, public
 * IPFS gateways) — never invented, never cached beyond the poll. Never
 * throws: every section degrades to an honest "unknown" so the dashboard
 * shows quiet states, not errors.
 *
 * Mission control appears only for wallets that own an AGENT blockpage
 * (on-chain ownerType). A human-owned page gets no panel — its blockpage
 * is its dashboard.
 */
import { resolvePageForOwner } from "../registry-reverse";
import { lookupBlockpage, checkProfilePin, type ProfilePinCheck } from "./mcp-tools";
import { fetchRecentTips, type RecentTipItem } from "./earnings";

const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";

export interface AgentStatus {
  username: string;
  /** lookup_blockpage found the name AND its on-chain owner is this wallet. */
  registered: boolean;
  /** The registry's owner for the name ("0.0.x"), when known. */
  registryOwnerAccount: string | null;
  /** The profile JSON actually loads through a public IPFS gateway. */
  profileReachable: boolean;
  /** The CID the registry points at, when known. */
  profileCid: string | null;
}

export interface AgentOverview {
  ownsAgentPage: boolean;
  ownerAccountId: string;
  username: string | null;
  status: AgentStatus | null;
  activity: { tips: RecentTipItem[] };
}

async function ownerEvmAddress(ownerAccountId: string): Promise<string | null> {
  try {
    const res = await fetch(`${MIRROR_BASE}/accounts/${ownerAccountId}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { evm_address?: unknown };
    return typeof body.evm_address === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.evm_address)
      ? body.evm_address.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function asPinCheck(p: ProfilePinCheck | { error: string } | null): ProfilePinCheck | null {
  return p && "reachable" in p ? p : null;
}

export async function getAgentOverview(ownerAccountId: string): Promise<AgentOverview> {
  const quiet: AgentOverview = {
    ownsAgentPage: false,
    ownerAccountId,
    username: null,
    status: null,
    activity: { tips: [] },
  };

  let page: { username: string; ownerType: "human" | "agent" } | null = null;
  try {
    page = await resolvePageForOwner(ownerAccountId);
  } catch {
    return quiet;
  }
  if (!page || page.ownerType !== "agent") return quiet;

  const [lookup, pinRaw, evm] = await Promise.all([
    lookupBlockpage(page.username).catch(() => ({
      found: false as const,
      username: page!.username,
    })),
    checkProfilePin({ username: page.username }).catch(() => null),
    ownerEvmAddress(ownerAccountId).catch(() => null),
  ]);
  const pin = asPinCheck(pinRaw);

  const registered =
    lookup.found === true &&
    typeof lookup.owner_account === "string" &&
    lookup.owner_account.trim() === ownerAccountId;

  const tips = evm ? await fetchRecentTips(evm, 5).catch(() => []) : [];

  return {
    ownsAgentPage: true,
    ownerAccountId,
    username: page.username,
    status: {
      username: page.username,
      registered,
      registryOwnerAccount:
        lookup.found === true && typeof lookup.owner_account === "string"
          ? lookup.owner_account
          : null,
      profileReachable: pin?.reachable ?? false,
      profileCid:
        pin?.cid ?? (lookup.found === true ? (lookup.ipfs_hash ?? null) : null),
    },
    activity: { tips },
  };
}
