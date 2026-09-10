"use client";

/**
 * Reputation: <ReputationBadge username> shows the score with a
 * trust/caution label; <VoteControls> lets the viewer up/down-vote once
 * (voter = their own page username).
 *
 * If the reputation API is not up yet, the badge hides itself and voting
 * shows a gentle error — the rest of the page keeps working.
 */
import { useCallback, useEffect, useState } from "react";
import { getJson, postJson, type ReputationInfo } from "@/lib/townhall";
import { useWriteGate } from "./useTownhall";

function badgeLabel(score: number): { text: string; tone: "good" | "bad" | "neutral" } {
  if (score >= 10) return { text: `+${score} trusted`, tone: "good" };
  if (score >= 1) return { text: `+${score}`, tone: "good" };
  if (score <= -5) return { text: `${score} caution`, tone: "bad" };
  if (score < 0) return { text: `${score}`, tone: "bad" };
  return { text: "new", tone: "neutral" };
}

export function useReputation(target: string, voter: string | null) {
  const [info, setInfo] = useState<ReputationInfo | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!target) return;
    try {
      const q = voter ? `?target=${encodeURIComponent(target)}&voter=${encodeURIComponent(voter)}` : `?target=${encodeURIComponent(target)}`;
      const data = await getJson<ReputationInfo>(`/api/townhall/reputation${q}`);
      setInfo({
        target: String(data.target ?? target),
        up: Number(data.up ?? 0),
        down: Number(data.down ?? 0),
        score: Number(data.score ?? 0),
        myVote: data.myVote === 1 ? 1 : data.myVote === -1 ? -1 : 0,
      });
    } catch {
      setFailed(true);
    }
  }, [target, voter]);

  useEffect(() => {
    load();
  }, [load]);

  return { info, failed, reload: load };
}

export default function ReputationBadge({
  username,
  compact = false,
}: {
  username: string;
  compact?: boolean;
}) {
  const { username: me } = useWriteGate();
  const { info, failed } = useReputation(username, me);

  if (failed || !info) return null;
  const { text, tone } = badgeLabel(info.score);
  return (
    <span
      className={`th-rep is-${tone}${compact ? " is-compact" : ""}`}
      title={`${info.up} up · ${info.down} down — only verified buyers (completed on-chain purchases) can vote`}
    >
      {text}
    </span>
  );
}

export function VoteControls({ target }: { target: string }) {
  const { username, canWrite, isAuthenticated } = useWriteGate();
  const { info, failed, reload } = useReputation(target, username);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vote = async (value: 1 | -1) => {
    setError(null);
    if (!canWrite) {
      setError(isAuthenticated ? "Set your page username (above) to vote." : "Sign in with your wallet to vote.");
      return;
    }
    if (info?.myVote === value) return; // already voted this way
    setBusy(true);
    try {
      await postJson("/api/townhall/reputation", { target, voter: username, value });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (failed) return null;

  return (
    <div className="th-votes">
      <button
        type="button"
        className={`th-vote${info?.myVote === 1 ? " is-active" : ""}`}
        onClick={() => vote(1)}
        disabled={busy}
        aria-label={`Upvote ${target}`}
        aria-pressed={info?.myVote === 1}
      >
        ▲ {info ? info.up : "…"}
      </button>
      <button
        type="button"
        className={`th-vote${info?.myVote === -1 ? " is-active" : ""}`}
        onClick={() => vote(-1)}
        disabled={busy}
        aria-label={`Downvote ${target}`}
        aria-pressed={info?.myVote === -1}
      >
        ▼ {info ? info.down : "…"}
      </button>
      {error && <span className="th-error">{error}</span>}
    </div>
  );
}
