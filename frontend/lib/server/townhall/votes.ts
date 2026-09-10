/**
 * Voicescape Social Town Hall — vote + listing aggregation.
 *
 * HCS is append-only, so all of these are "latest per key wins" over the
 * ordered message stream. All functions are pure and unit-testable.
 */

import type {
  ListingMessage,
  PostMessage,
  ProposalMessage,
  ProposalVoteMessage,
  RepVoteMessage,
  StoredMessage,
  TownhallMessage,
} from "./types";

function isKind<T extends TownhallMessage>(m: StoredMessage, kind: string): m is StoredMessage<T> {
  return m.contents.kind === kind;
}

/* ------------------------------------------------------------------ */
/* Reputation                                                         */
/* ------------------------------------------------------------------ */

export interface RepTally {
  up: number;
  down: number;
  score: number;
}

/**
 * Aggregate rep-votes: latest per (voter, target) wins. Self-votes are
 * ignored at aggregation time as defense-in-depth (the POST route also
 * rejects them with 400).
 */
export function aggregateRepVotes(
  messages: StoredMessage[],
  target: string,
  voter?: string,
): { up: number; down: number; score: number; myVote: 1 | -1 | null } {
  const t = target.toLowerCase();
  const latest = new Map<string, 1 | -1>();
  for (const m of messages) {
    if (!isKind<RepVoteMessage>(m, "rep-vote")) continue;
    const v = m.contents;
    if (v.target.toLowerCase() !== t) continue;
    if (v.voter.toLowerCase() === t) continue; // self-votes don't count
    if (v.value !== 1 && v.value !== -1) continue;
    latest.set(v.voter.toLowerCase(), v.value);
  }
  let up = 0;
  let down = 0;
  for (const value of latest.values()) {
    if (value === 1) up += 1;
    else down += 1;
  }
  const myVote = voter ? (latest.get(voter.toLowerCase()) ?? null) : null;
  return { up, down, score: up - down, myVote };
}

/* ------------------------------------------------------------------ */
/* Proposals                                                          */
/* ------------------------------------------------------------------ */

export interface ProposalTally {
  yes: number;
  no: number;
  abstain: number;
}

/** Count proposal votes: latest per (voter, proposal) wins. */
export function countProposalVotes(messages: StoredMessage[], proposalId: string): ProposalTally {
  const latest = new Map<string, "yes" | "no" | "abstain">();
  for (const m of messages) {
    if (!isKind<ProposalVoteMessage>(m, "proposal-vote")) continue;
    const v = m.contents;
    if (v.proposal !== proposalId) continue;
    if (v.choice !== "yes" && v.choice !== "no" && v.choice !== "abstain") continue;
    latest.set(v.voter.toLowerCase(), v.choice);
  }
  const tally: ProposalTally = { yes: 0, no: 0, abstain: 0 };
  for (const choice of latest.values()) tally[choice] += 1;
  return tally;
}

export function collectProposals(messages: StoredMessage[]): StoredMessage<ProposalMessage>[] {
  return messages.filter((m): m is StoredMessage<ProposalMessage> => isKind<ProposalMessage>(m, "proposal"));
}

/* ------------------------------------------------------------------ */
/* Posts (ordering + filtering)                                       */
/* ------------------------------------------------------------------ */

export function collectPosts(messages: StoredMessage[]): StoredMessage<PostMessage>[] {
  return messages.filter((m): m is StoredMessage<PostMessage> => isKind<PostMessage>(m, "post"));
}

/** Sort by seq descending (newest first). Pure — unit-testable. */
export function orderNewestFirst<T extends { seq: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.seq - a.seq);
}

/* ------------------------------------------------------------------ */
/* Listings (latest per id wins)                                      */
/* ------------------------------------------------------------------ */

/** Latest message per listing id wins — covers status updates. */
export function aggregateListings(messages: StoredMessage[]): Map<string, StoredMessage<ListingMessage>> {
  const latest = new Map<string, StoredMessage<ListingMessage>>();
  for (const m of messages) {
    if (!isKind<ListingMessage>(m, "listing")) continue;
    latest.set(m.contents.id, m);
  }
  return latest;
}
