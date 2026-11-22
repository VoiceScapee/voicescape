/**
 * Voicescape — poll handlers (webseries blocks).
 *
 * Free, no-pay votes that decide something real (e.g. the next episode's
 * topic). Handlers are Next-agnostic and take injectable deps so they
 * stay directly unit-testable.
 *
 * Vote rule (E11): one vote per IP per poll — a second vote from the
 * same IP is rejected, honestly, with the choice already made. No
 * wallet, no fee, no pay-to-vote, ever. A poll ending with zero votes
 * picks nothing and says so; a tie at the top is broken by Brandon
 * (the renderer says so — the server never invents a winner).
 */

import { getKvStore, type KvStore } from "../store";
import {
  getPollResults as storeResults,
  hasVoted,
  hashIp,
  recordVote,
  type PollResults,
} from "./store";

export interface PollDeps {
  store: KvStore;
}

export function defaultPollDeps(): PollDeps {
  return { store: getKvStore() };
}

export type HandlerResult = { status: number; json: unknown };

const err = (status: number, error: string): HandlerResult => ({ status, json: { error } });

/** Page usernames: lowercase, tight charset. */
export function normalizePage(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const p = input.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(p) ? p : null;
}

/** Poll ids: author-chosen slugs, or a slug of the question. */
export function normalizePollId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const id = input.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? id : null;
}

function validOptions(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const options = input
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().slice(0, 80))
    .filter((x) => x.length > 0)
    .slice(0, 6);
  return options.length >= 2 ? options : null;
}

export interface PollResultsResponse extends PollResults {
  /** The caller's own choice, when this IP already voted. */
  votedOption: number | null;
}

export async function getPoll(
  deps: PollDeps,
  pageInput: unknown,
  pollIdInput: unknown,
  ip: string,
): Promise<HandlerResult> {
  const page = normalizePage(pageInput);
  const pollId = normalizePollId(pollIdInput);
  if (!page || !pollId) return err(400, "unknown page or poll");
  const results = await storeResults(deps.store, page, pollId);
  const votedOption = await hasVoted(deps.store, page, pollId, hashIp(ip));
  return {
    status: 200,
    json: { ...results, votedOption } satisfies PollResultsResponse,
  };
}

export async function castVote(
  deps: PollDeps,
  pageInput: unknown,
  pollIdInput: unknown,
  input: { optionIndex?: unknown; options?: unknown },
  ip: string,
): Promise<HandlerResult> {
  const page = normalizePage(pageInput);
  const pollId = normalizePollId(pollIdInput);
  if (!page || !pollId) return err(400, "unknown page or poll");
  const options = validOptions(input.options);
  if (!options) return err(400, "a poll needs 2–6 options");
  if (
    typeof input.optionIndex !== "number" ||
    !Number.isInteger(input.optionIndex) ||
    input.optionIndex < 0 ||
    input.optionIndex >= options.length
  ) {
    return err(400, "pick one of the options");
  }
  const outcome = await recordVote(
    deps.store,
    page,
    pollId,
    options,
    input.optionIndex,
    hashIp(ip),
  );
  if (outcome.status === "already-voted") {
    return {
      status: 409,
      json: {
        error: "you already voted in this poll",
        votedOption: outcome.votedOption,
      },
    };
  }
  if (outcome.status === "options-mismatch") {
    return {
      status: 409,
      json: {
        error:
          "this poll's options changed since voting started — the page owner needs a new poll id",
      },
    };
  }
  const votedOption = input.optionIndex;
  return { status: 200, json: { ...outcome.results, votedOption } satisfies PollResultsResponse };
}
