"use client";

/**
 * <CommentWall username> — the guestbook on a user's block page.
 *
 * Reads posts with wall=<username>; the composer posts with the viewer's
 * page username as author (dust-fee flow applies). Moderation goes through
 * the server: the Hide button on each comment (visible only to authorized
 * moderators — global mods or the wall owner) posts a mod-action to
 * /api/townhall/mod-actions, and hidden comments are filtered out of reads
 * for everyone. Hides are permanent in v1 (HCS is append-only).
 */
import { useCallback, useEffect, useState } from "react";
import PostCard from "./PostCard";
import DustFeeGate from "./DustFeeGate";
import { useDustFee, useWriteGate } from "./useTownhall";
import { getJson, postJson, type TownhallPost } from "@/lib/townhall";

export default function CommentWall({
  username,
}: {
  username: string;
  /** Registry owner address of the wall's page (kept for API stability). */
  owner: string;
}) {
  const { username: me, canWrite, isAuthenticated } = useWriteGate();
  const dust = useDustFee();
  const [posts, setPosts] = useState<TownhallPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ posts?: TownhallPost[] }>(
        `/api/townhall/posts?wall=${encodeURIComponent(username)}&limit=50`,
      );
      setPosts(Array.isArray(data.posts) ? data.posts : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [username]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    const text = body.trim();
    if (!text) return;
    if (!canWrite) {
      dust.reset();
      return;
    }
    const ok = await dust.execute(async (dustFeeTxId) => {
      await postJson<{ seq: number }>("/api/townhall/posts", {
        wall: username,
        body: text,
        author: me,
        dustFeeTxId,
      });
    });
    if (ok) {
      setBody("");
      load();
    }
  };

  return (
    <section className="th-wall" aria-label={`Comments on @${username}`}>
      <h2 className="th-h2">💬 Comment wall</h2>

      <div className="th-composer">
        <textarea
          className="vs-input th-textarea"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={me ? `Say something nice on @${username}'s wall…` : isAuthenticated ? "Set your page username (top of the page) to comment…" : "Sign in with your wallet to comment…"}
          rows={2}
          aria-label={`Comment on @${username}'s wall`}
        />
        <div className="th-row">
          <button
            type="button"
            className="vs-btn vs-btn-primary th-btn-sm"
            onClick={submit}
            disabled={dust.phase.kind === "working" || dust.phase.kind === "paying" || !body.trim()}
          >
            {dust.phase.kind === "working" || dust.phase.kind === "paying" ? "Posting…" : "Post comment"}
          </button>
          {!canWrite && <span className="th-muted">{isAuthenticated ? "You need a page username to comment." : "Sign in with your wallet to comment."}</span>}
        </div>
        <DustFeeGate flow={dust} actionLabel="comment" />
      </div>

      {loading && <p className="th-muted">Loading comments…</p>}
      {error && (
        <p className="th-error">
          Couldn&apos;t load comments: {error}{" "}
          <button type="button" className="th-identity-link" onClick={load}>
            retry
          </button>
        </p>
      )}
      {!loading && !error && posts.length === 0 && (
        <p className="th-muted">No comments yet — be the first.</p>
      )}
      <div className="th-post-list">
        {posts.map((p) => (
          <div key={p.seq} className="th-wall-item">
            <PostCard post={p} onHidden={load} />
          </div>
        ))}
      </div>
    </section>
  );
}
