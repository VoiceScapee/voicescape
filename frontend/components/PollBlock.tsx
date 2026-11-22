"use client";

/**
 * <PollBlock page pollId question options> — a free, no-pay vote.
 *
 * Reads/writes /api/polls/<page>/<pollId>. One vote per IP per poll
 * (server-enforced); the first vote defines the ballot, so the options
 * shown are the options as voted on. A poll with zero votes picks
 * nothing and says so; a tie at the top is broken by Brandon — the
 * component never invents a winner.
 */
import { useCallback, useEffect, useState } from "react";

interface PollState {
  options: string[] | null;
  counts: number[];
  total: number;
  votedOption: number | null;
}

export default function PollBlock({
  page,
  pollId,
  question,
  options,
}: {
  page: string;
  pollId: string;
  question: string;
  options: string[];
}) {
  const [results, setResults] = useState<PollState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [voting, setVoting] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);

  const url = `/api/polls/${encodeURIComponent(page)}/${encodeURIComponent(pollId)}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : "couldn't load the poll");
      setResults({
        options: Array.isArray(data.options) ? data.options : null,
        counts: Array.isArray(data.counts) ? data.counts : [],
        total: typeof data.total === "number" ? data.total : 0,
        votedOption: typeof data.votedOption === "number" ? data.votedOption : null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    load();
  }, [load]);

  // The options as voted on are the truth; the block's options are the
  // ballot before anyone votes. If they differ, the ballot changed — say so.
  const displayOptions = results?.options ?? options;
  const ballotChanged =
    results !== null &&
    results.options !== null &&
    (results.options.length !== options.length ||
      results.options.some((o, i) => o !== options[i]));

  const vote = async (optionIndex: number) => {
    if (voting) return;
    setVoting(true);
    setVoteError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionIndex, options: displayOptions }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 409) {
        throw new Error(typeof data?.error === "string" ? data.error : "couldn't record your vote");
      }
      // 409 = already voted (or ballot changed) — the fresh results are
      // the honest answer either way.
      await load();
      if (res.status === 409 && typeof data?.error === "string") setVoteError(data.error);
    } catch (e) {
      setVoteError(e instanceof Error ? e.message : String(e));
    } finally {
      setVoting(false);
    }
  };

  const hasVoted = results !== null && results.votedOption !== null;
  const maxCount = results ? Math.max(0, ...results.counts) : 0;
  const tied =
    results !== null &&
    results.total > 0 &&
    results.counts.filter((c) => c === maxCount).length > 1;

  return (
    <section className="pv-block pv-poll" aria-label={question}>
      <h2 className="pv-block-title">
        <span aria-hidden="true">📊</span>
        <span>{question}</span>
      </h2>
      {ballotChanged && (
        <p className="pv-poll-note">
          This poll&apos;s options were set when voting started — these are the options people voted on.
        </p>
      )}
      {loading && <p className="pv-empty">Loading the poll…</p>}
      {error && (
        <p className="th-error">
          Couldn&apos;t load the poll: {error}{" "}
          <button type="button" className="th-identity-link" onClick={load}>
            retry
          </button>
        </p>
      )}
      {!loading && !error && results !== null && (
        <>
          {!hasVoted && results.total === 0 && (
            <p className="pv-poll-note">No votes yet — be the first to vote. Free, no sign-in.</p>
          )}
          {!hasVoted && results.total > 0 && (
            <p className="pv-poll-note">
              {results.total} {results.total === 1 ? "vote" : "votes"} so far — pick one, free, no sign-in.
            </p>
          )}
          <ul className="pv-poll-options">
            {displayOptions.map((opt, i) => {
              const count = results.counts[i] ?? 0;
              const pct = results.total > 0 ? Math.round((count / results.total) * 100) : 0;
              const isMine = results.votedOption === i;
              const isLeader = hasVoted && count === maxCount && count > 0;
              return (
                <li key={i} className="pv-poll-option">
                  {hasVoted ? (
                    <div className={`pv-poll-result${isMine ? " is-mine" : ""}${isLeader ? " is-leader" : ""}`}>
                      <span className="pv-poll-label">
                        {opt}
                        {isMine ? " — your vote" : ""}
                        {isLeader && tied ? " — tied at the top" : ""}
                      </span>
                      <span className="pv-poll-bar" aria-hidden="true">
                        <i style={{ width: `${pct}%` }} />
                      </span>
                      <span className="pv-poll-count vs-mono">
                        {count} {count === 1 ? "vote" : "votes"} · {pct}%
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="vs-btn pv-poll-vote"
                      onClick={() => vote(i)}
                      disabled={voting}
                    >
                      {opt}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {hasVoted && (
            <p className="pv-poll-note">
              {results.total} {results.total === 1 ? "vote" : "votes"} total.
              {tied ? " Tied at the top — Brandon breaks ties." : ""}
            </p>
          )}
          {voteError && (
            <p className="th-error" role="alert">
              {voteError}{" "}
              <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={() => setVoteError(null)}>
                Dismiss
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}
