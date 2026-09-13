/**
 * Fundraiser board aggregation.
 *
 * The fundraiser board (/fundraiser) lists every creator funding goal as a
 * campaign card. It reuses the existing funding-goal records
 * (lib/server/goals.ts) — no new money movement, no contract changes.
 * Donations are ordinary on-chain tips to the creator's blockpage (the
 * proven 98/2 Tips contract path); the board just aggregates the public
 * goal + the creator's all-time tipped total from the mirror node.
 *
 * Storage: the `fundraisers:index` key holds the usernames with goals.
 * Reads are public. Stale index entries (goal cleared) are skipped.
 */
import type { KvStore } from "./store";
import { getKvStore } from "./store";
import { readFundraiserUsernames, readGoal, type FundingGoal } from "./goals";

export interface FundraiserEntry {
  username: string;
  title: string | null;
  targetHbar: number;
  /** Owner EVM address (lowercase). */
  owner: string;
  /** All-time tips to the owner, HBAR. 0 when unreadable. */
  raisedHbar: number;
  createdAt: string;
  updatedAt: string;
}

export interface FundraiserDeps {
  store: KvStore;
  /** Username → owner EVM address, or null when unresolvable. */
  resolveOwner: (username: string) => Promise<string | null>;
  /** All-time tipped HBAR for an owner address; null when unreadable. */
  raisedFor: (ownerAddress: string) => Promise<number | null>;
}

export function defaultFundraiserDeps(): FundraiserDeps {
  return {
    store: getKvStore(),
    resolveOwner: async (username: string) => {
      const { resolveUsernameWallet } = await import("./townhall/badges");
      return resolveUsernameWallet(username);
    },
    raisedFor: async (ownerAddress: string) => {
      const { fetchEarningsSummary } = await import("./earnings");
      const res = await fetchEarningsSummary(ownerAddress.toLowerCase());
      if (!res.ok) return null;
      const n = res.summary.hbarAllTime;
      return Number.isFinite(n) ? n : null;
    },
  };
}

/**
 * List every active fundraiser, newest first. Never throws — a failure to
 * read the index returns an empty board; per-entry failures skip that entry.
 */
export async function listFundraisers(deps: FundraiserDeps): Promise<FundraiserEntry[]> {
  let usernames: string[];
  try {
    usernames = await readFundraiserUsernames(deps.store);
  } catch {
    return [];
  }
  const out: FundraiserEntry[] = [];
  for (const username of usernames) {
    let goal: FundingGoal | null;
    try {
      goal = await readGoal(deps.store, username);
    } catch {
      continue;
    }
    if (!goal) continue; // stale index entry
    let owner: string | null;
    try {
      owner = await deps.resolveOwner(goal.username);
    } catch {
      continue;
    }
    if (!owner) continue;
    let raised: number | null = null;
    try {
      raised = await deps.raisedFor(owner.toLowerCase());
    } catch {
      raised = null;
    }
    const raisedHbar = raised ?? 0;
    // Completion rule: a fundraiser that reached its goal leaves the board —
    // it is not needed there anymore. Derived at read time from on-chain
    // totals, so there is no cron and no state machine. The blockpage keeps
    // its permanent "Goal reached" record, and the creator can set a new
    // goal at any time to return to the board.
    if (raisedHbar >= goal.targetHbar) continue;
    out.push({
      username: goal.username,
      title: goal.title,
      targetHbar: goal.targetHbar,
      owner: owner.toLowerCase(),
      raisedHbar,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out;
}
