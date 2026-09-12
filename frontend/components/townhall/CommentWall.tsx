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
import { pollTransactionStatus } from "@/lib/tx-confirm";
import { getJson, postJson, type TownhallPost } from "@/lib/townhall";

/**
 * A client-side optimistic entry: shown immediately with a "confirming…"
 * indicator, replaced by the real post once it arrives from the server.
 */
type PendingPost = TownhallPost & { pending?: boolean; unconfirmed?: boolean };

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
  const [optimistic, setOptimistic] = useState<PendingPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  // Transient "what's next" note after on-chain confirmation lands.
  const [justPosted, setJustPosted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ posts?: TownhallPost[] }>(
        `/api/townhall/posts?wall=${encodeURIComponent(username)}&limit=50`,
      );
      const real = Array.isArray(data.posts) ? data.posts : [];
      setPosts(real);
      // Drop optimistic entries whose real copy has arrived from the server.
      const realKeys = new Set(real.map((p) => `${p.author}::${p.body}`));
      setOptimistic((prev) => prev.filter((p) => !realKeys.has(`${p.author}::${p.body}`)));
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
    // Optimistic: show the comment NOW with a "confirming…" indicator and
    // clear the composer — no frozen "posting" state while the network works.
    const tempSeq = -Date.now();
    setOptimistic((prev) => [
      ...prev,
      {
        seq: tempSeq,
        board: "general",
        wall: username,
        author: me,
        body: text,
        replyTo: null,
        ts: Date.now(),
        pending: true,
      },
    ]);
    setBody("");
    setPostError(null);
    try {
      await postJson("/api/townhall/posts", {
        wall: username,
        body: text,
        author: me,
        hcsTxId,
      });
    } catch (e) {
      // Server verification failed — the HCS tx is still on-chain, but the
      // server didn't accept it (e.g., content filter). Drop the optimistic
      // entry and show the error.
      setOptimistic((prev) => prev.filter((p) => p.seq !== tempSeq));
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Comment verification failed:", e);
      setPostError(`Comment not published: ${msg}. Your transaction is on-chain, but the server rejected it.`);
      return;
    }
    // Server accepted it. Confirm the HCS message on-chain in the
    // background: on success the wall refreshes and the optimistic entry is
    // replaced by the real one; on failure the entry is removed with an
    // error; on timeout the entry stays, honestly flagged "not yet
    // confirmed" rather than silently dropped.
    void pollTransactionStatus(hcsTxId, { timeoutMs: 50_000 }).then((outcome) => {
      if (outcome === "confirmed") {
        load();
        // Tell the user what's next: the comment is live on the wall now.
        setJustPosted(true);
        setTimeout(() => setJustPosted(false), 8000);
      } else if (outcome === "failed") {
        setOptimistic((prev) => prev.filter((p) => p.seq !== tempSeq));
        setPostError("The transaction failed on-chain — your comment was not posted.");
      } else {
        setOptimistic((prev) =>
          prev.map((p) => (p.seq === tempSeq ? { ...p, pending: false, unconfirmed: true } : p)),
        );
      }
    });
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
        {hcs.phase.kind === "submitting" && hcs.waitingLong && (
          <p className="th-muted" role="status" style={{ marginTop: 8 }}>
            Still working — if you already approved in your wallet, the network is confirming.
            This can take up to ~90 seconds; please keep this page open.
          </p>
        )}
        {postError && (
          <p className="th-error" role="alert" style={{ marginTop: 8 }}>
            {postError}{" "}
            <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={() => setPostError(null)}>
              Dismiss
            </button>
          </p>
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
      {!loading && !error && posts.length === 0 && optimistic.length === 0 && (
        <p className="th-muted">No comments yet — be the first.</p>
      )}
      <div className="th-post-list">
        {justPosted && (
          <p className="th-note" role="status" style={{ marginBottom: 8 }}>
            ✓ Posted — your comment is now live on the wall.
          </p>
        )}
        {optimistic.map((p) => (
          <div key={p.seq} className="th-wall-item">
            <PostCard post={p} />
          </div>
        ))}
        {posts.map((p) => (
          <div key={p.seq} className="th-wall-item">
            <PostCard post={p} onHidden={load} />
          </div>
        ))}
      </div>
    </section>
  );
}
