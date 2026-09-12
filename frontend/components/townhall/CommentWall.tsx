"use client";

/**
 * <CommentWall username> — the guestbook on a user's block page.
 *
 * Reads posts with wall=<username>; the composer posts with the viewer's
 * page username as author (user-signed HCS flow applies). Moderation goes through
 * the server: the Hide button on each comment (visible only to authorized
 * moderators — global mods or the wall owner) posts a mod-action to
 * /api/townhall/mod-actions, and hidden comments are filtered out of reads
 * for everyone. Hides are permanent in v1 (HCS is append-only).
 */
import { useCallback, useEffect, useState } from "react";
import PostCard from "./PostCard";
import { useWriteGate } from "./useTownhall";
import { useHcsSubmit } from "./useHcsSubmit";
import { getJson, postJson, type TownhallPost } from "@/lib/townhall";

export default function CommentWall({
  username,
}: {
  username: string;
  /** Registry owner address of the wall's page (kept for API stability). */
  owner: string;
}) {
  const { username: me, canWrite, isAuthenticated } = useWriteGate();
  const hcs = useHcsSubmit();
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
    if (!text || !canWrite || !me) return;
    // Submit the comment via the user's wallet, then notify the server
    // (it verifies the HCS tx via mirror node).
    const hcsTxId = await hcs.submit("forum", {
      v: 1,
      kind: "post",
      ts: new Date().toISOString(),
      author: me,
      board: "general",
      wall: username,
      body: text,
      replyTo: null,
    });
    if (!hcsTxId) return; // User cancelled or error — phase shows the error
    try {
      await postJson("/api/townhall/posts", {
        wall: username,
        body: text,
        author: me,
        hcsTxId,
      });
    } catch (e) {
      // Server verification failed — the HCS tx is still on-chain, but the
      // server didn't accept it (e.g., content filter). Show the error.
      console.error("Comment verification failed:", e);
      return;
    }
    setBody("");
    load();
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
            disabled={hcs.phase.kind === "submitting" || !body.trim()}
          >
            {hcs.phase.kind === "submitting" ? "Sign in wallet…" : "Post comment"}
          </button>
          {!canWrite && <span className="th-muted">{isAuthenticated ? "You need a page username to comment." : "Sign in with your wallet to comment."}</span>}
        </div>
        {hcs.phase.kind === "error" && (
          <p className="th-error">Failed to submit: {hcs.phase.message}</p>
        )}
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
