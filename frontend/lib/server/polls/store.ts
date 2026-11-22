/**
 * Voicescape — poll vote storage (webseries blocks).
 *
 * One poll per (page, pollId). The first vote defines the ballot: the
 * options as authored on the page are stored with the first vote, and
 * later votes must match them — if the page author changes the options
 * they must change the poll id (documented on the block). Voters are
 * one-way IP hashes (sha256, "polls|" domain); the hash list is never
 * exposed via the API.
 *
 * Backed by the shared KvStore (Valkey → Upstash → memory), so it works
 * on every instance with zero new infrastructure. 90-day rolling TTL,
 * refreshed on every vote — a poll is page content, not a permanent
 * record.
 */

import type { KvStore } from "../store";
import { createHash } from "crypto";

/** What the API sends to browsers (voters never included). */
export interface PollResults {
  /** The options as voted on (null when no votes yet — render the block's). */
  options: string[] | null;
  counts: number[];
  total: number;
}

export interface PollState extends PollResults {
  options: string[];
  /** One-way hashes of voter IPs. */
  voters: string[];
}

const PREFIX = "polls:v1";
const POLL_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 3000;

const kPoll = (page: string, pollId: string) => `${PREFIX}:poll:${page}:${pollId}`;
const kLock = (page: string, pollId: string) => `${PREFIX}:lock:${page}:${pollId}`;

/** One-way IP fingerprint for one-vote-per-IP matching. Not PII storage. */
export function hashIp(ip: string): string {
  return createHash("sha256").update(`polls|${ip}`).digest("hex").slice(0, 32);
}

function parseState(raw: string | null): PollState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PollState>;
    if (!Array.isArray(v.options) || !Array.isArray(v.counts)) return null;
    if (v.options.length !== v.counts.length) return null;
    return {
      options: v.options.filter((o): o is string => typeof o === "string"),
      counts: v.counts.filter((c): c is number => typeof c === "number"),
      voters: Array.isArray(v.voters)
        ? v.voters.filter((x): x is string => typeof x === "string")
        : [],
      total: 0,
    };
  } catch {
    return null;
  }
}

function toResults(state: PollState | null): PollResults {
  if (!state) return { options: null, counts: [], total: 0 };
  const total = state.counts.reduce((a, b) => a + b, 0);
  return { options: state.options, counts: state.counts, total };
}

/** Serialize with a best-effort lock so concurrent voters don't clobber each other. */
async function withPollLock<T>(
  store: KvStore,
  page: string,
  pollId: string,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await store.setNx(kLock(page, pollId), "1", LOCK_TTL_MS)) {
      try {
        return await fn();
      } finally {
        await store.del(kLock(page, pollId)).catch(() => {});
      }
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("[polls] poll busy — try again");
}

export async function getPollResults(
  store: KvStore,
  page: string,
  pollId: string,
): Promise<PollResults> {
  return toResults(parseState(await store.get(kPoll(page, pollId))));
}

export async function hasVoted(
  store: KvStore,
  page: string,
  pollId: string,
  voterHash: string,
): Promise<number | null> {
  const state = parseState(await store.get(kPoll(page, pollId)));
  if (!state) return null;
  // Voters entries are "<hash>:<optionIndex>", so a returning voter
  // sees the choice they already made.
  const hit = state.voters.find((v) => v.startsWith(`${voterHash}:`));
  if (!hit) return null;
  const idx = Number(hit.slice(voterHash.length + 1));
  return Number.isInteger(idx) ? idx : null;
}

export type VoteOutcome =
  | { status: "ok"; results: PollResults }
  | { status: "already-voted"; votedOption: number }
  | { status: "options-mismatch" };

/**
 * Record a vote. The first vote defines the ballot (options stored);
 * later votes must match the stored options exactly. One vote per IP:
 * a second vote from the same IP is rejected with its original choice.
 */
export async function recordVote(
  store: KvStore,
  page: string,
  pollId: string,
  options: string[],
  optionIndex: number,
  voterHash: string,
): Promise<VoteOutcome> {
  return withPollLock(store, page, pollId, async () => {
    const existing = parseState(await store.get(kPoll(page, pollId)));
    if (existing) {
      const prior = existing.voters.find((v) => v.startsWith(`${voterHash}:`));
      if (prior) {
        const idx = Number(prior.slice(voterHash.length + 1));
        return {
          status: "already-voted",
          votedOption: Number.isInteger(idx) ? idx : 0,
        };
      }
      if (
        existing.options.length !== options.length ||
        existing.options.some((o, i) => o !== options[i])
      ) {
        return { status: "options-mismatch" };
      }
      existing.counts[optionIndex] += 1;
      existing.voters.push(`${voterHash}:${optionIndex}`);
      await store.set(kPoll(page, pollId), JSON.stringify(existing), POLL_TTL_MS);
      return { status: "ok", results: toResults(existing) };
    }
    const state: PollState = {
      options: [...options],
      counts: options.map((_, i) => (i === optionIndex ? 1 : 0)),
      voters: [`${voterHash}:${optionIndex}`],
      total: 0,
    };
    await store.set(kPoll(page, pollId), JSON.stringify(state), POLL_TTL_MS);
    return { status: "ok", results: toResults(state) };
  });
}
