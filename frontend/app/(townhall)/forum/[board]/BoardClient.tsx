"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PostCard from "@/components/townhall/PostCard";
import { PresenceDot } from "@/components/townhall/Presence";
import { useWriteGate } from "@/components/townhall/useTownhall";
import { useHcsSubmit } from "@/components/townhall/useHcsSubmit";
import { useStreamEvents } from "@/components/townhall/useStream";
import { pollTransactionStatus } from "@/lib/tx-confirm";
import { getJson, postJson, type TownhallPost } from "@/lib/townhall";
import { IconClose } from "@/components/icons";

/**
 * A client-side optimistic entry: shown immediately with a "confirming…"
 * indicator, replaced by the real post once it arrives over the stream.
 */
type PendingPost = TownhallPost & { pending?: boolean; unconfirmed?: boolean };

interface ThreadNode {
  post: TownhallPost;
  children: ThreadNode[];
}

function buildThreads(posts: TownhallPost[]): ThreadNode[] {
  const bySeq = new Map<number, ThreadNode>();
  const roots: ThreadNode[] = [];
  for (const p of posts) bySeq.set(p.seq, { post: p, children: [] });
  for (const p of posts) {
    const node = bySeq.get(p.seq)!;
    const parent = p.replyTo != null ? bySeq.get(p.replyTo) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (nodes: ThreadNode[]) => {
    nodes.sort((a, b) => a.post.ts - b.post.ts);
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

function isPostView(m: unknown): m is TownhallPost {
  return (
    !!m &&
    typeof m === "object" &&
    typeof (m as TownhallPost).seq === "number" &&
    typeof (m as { body?: unknown }).body === "string"
  );
}

/**
 * The REST/stream APIs send ISO-8601 `ts`, but the client type is epoch ms.
 * Normalize once at the boundary so sorting and timeAgo behave.
 */
function normalizePost(p: TownhallPost): TownhallPost {
  const ts = (p as unknown as { ts: unknown }).ts;
  return {
    ...p,
    ts: typeof ts === "string" ? Date.parse(ts) : typeof ts === "number" ? ts : Date.now(),
  };
}

function Thread({
  node,
  depth,
  onReply,
  onHidden,
}: {
  node: ThreadNode;
  depth: number;
  onReply: (p: TownhallPost) => void;
  onHidden: () => void;
}) {
  return (
    <div>
      <PostCard post={node.post} onReply={onReply} depth={depth} onHidden={onHidden} />
      {node.children.length > 0 && (
        <div className="th-post-list" style={{ marginTop: 8 }}>
          {node.children.map((c) => (
            <Thread key={c.post.seq} node={c} depth={depth + 1} onReply={onReply} onHidden={onHidden} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function BoardClient({ board }: { board: string }) {
  const { username: me, canWrite, isAuthenticated } = useWriteGate();
  const hcs = useHcsSubmit();
  const [posts, setPosts] = useState<TownhallPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<TownhallPost | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Transient "what's next" note after on-chain confirmation lands.
  const [justPosted, setJustPosted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ posts?: TownhallPost[] }>(
        `/api/townhall/posts?board=${encodeURIComponent(board)}&limit=100`,
      );
      setPosts(Array.isArray(data.posts) ? data.posts.map(normalizePost) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [board]);

  useEffect(() => {
    load();
  }, [load]);

  // Live: new posts arrive over SSE; prepend them (newest first).
  const mergePosts = useCallback((incoming: TownhallPost[]) => {
    if (incoming.length === 0) return;
    setPosts((prev) => {
      const seen = new Set(prev.map((p) => p.seq));
      const fresh = incoming.filter((p) => !seen.has(p.seq));
      if (fresh.length === 0) return prev;
      // When a real (positive-seq) copy of my optimistic post arrives,
      // drop the pending temp-seq copy (matched by author+body — the temp
      // seq never dedupes by seq alone).
      const confirmedKeys = new Set(
        fresh
          .filter((p) => p.seq > 0 && p.author === me)
          .map((p) => `${p.author}::${p.body}`),
      );
      const prevFiltered =
        confirmedKeys.size > 0
          ? prev.filter(
              (p) =>
                !(
                  (p as PendingPost).pending &&
                  confirmedKeys.has(`${p.author}::${p.body}`)
                ),
            )
          : prev;
      return [...fresh, ...prevFiltered].slice(0, 300);
    });
  }, [me]);

  const streamUrl = `/api/townhall/posts/stream?board=${encodeURIComponent(board)}`;
  const streamConn = useStreamEvents<TownhallPost>(
    streamUrl,
    (events) => mergePosts(events.map(normalizePost)),
    isPostView,
    { dataKey: "posts" },
  );

  const threads = useMemo(() => buildThreads(posts), [posts]);

  const onReply = useCallback((p: TownhallPost) => {
    setReplyTo(p);
    composerRef.current?.focus();
    composerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const submit = async () => {
    const text = body.trim();
    if (!text || !canWrite || !me) return;
    const replySeq = replyTo?.seq ?? null;

    // Construct the HCS message (user signs this in their wallet)
    const message = {
      v: 1,
      kind: "post",
      ts: new Date().toISOString(),
      author: me,
      board,
      wall: null,
      body: text,
      replyTo: replySeq,
    };

    // Submit to HCS via the user's wallet (they pay the fee, it's transparent)
    const hcsTxId = await hcs.submit("forum", message);
    if (!hcsTxId) return; // User cancelled or error

    // Optimistic: show it NOW with a "confirming…" indicator and clear the
    // composer — no frozen "posting" state while the network works.
    const tempSeq = -Date.now();
    const optimisticPost: PendingPost = {
      seq: tempSeq,
      board,
      wall: undefined,
      author: me,
      body: text,
      replyTo: replySeq,
      ts: Date.now(),
      pending: true,
    };
    setBody("");
    setReplyTo(null);
    setPostError(null);
    mergePosts([optimisticPost]);

    try {
      // Notify the server (it verifies the HCS tx via mirror node)
      await postJson("/api/townhall/posts", {
        board,
        body: text,
        replyTo: replySeq,
        author: me,
        hcsTxId,
      });
    } catch (e) {
      // Server verification failed - the HCS tx is still on-chain, but the
      // server didn't accept it (e.g., content filter). Drop the optimistic
      // entry and show the error.
      setPosts((prev) => prev.filter((p) => p.seq !== tempSeq));
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Post verification failed:", e);
      setPostError(`Post not published: ${msg}. Your HCS transaction is on-chain, but the server rejected it.`);
      return;
    }

    // Server accepted it. Confirm the HCS message on-chain in the
    // background: the stream usually delivers the real copy first (dedupe
    // above swaps it in); on failure the entry is removed with an error; on
    // timeout the entry stays, honestly flagged "not yet confirmed".
    void pollTransactionStatus(hcsTxId, { timeoutMs: 50_000 }).then((outcome) => {
      if (outcome === "confirmed") {
        load();
        // Tell the user what's next: the post is live in the thread now.
        setJustPosted(true);
        setTimeout(() => setJustPosted(false), 8000);
      } else if (outcome === "failed") {
        setPosts((prev) => prev.filter((p) => p.seq !== tempSeq));
        setPostError("The transaction failed on-chain — your post was not published.");
      } else {
        setPosts((prev) =>
          prev.map((p) =>
            p.seq === tempSeq ? { ...p, pending: false, unconfirmed: true } : p,
          ),
        );
      }
    });
  };

  return (
    <>
      <div className="th-page-head">
        <h1>{board}</h1>
        <p>
          Newest threads first — reply inline, tip posts you like.{" "}
          {streamConn === "live" && <span className="th-chat-status is-live">● live</span>}{" "}
          <PresenceDot scope={`forum:${board}`} />
        </p>
      </div>

      <div className="th-composer">
        {replyTo && (
          <div className="th-row" style={{ marginBottom: 10 }}>
            <span className="th-muted">
              Replying to <strong>@{replyTo.author}</strong>: “{replyTo.body.slice(0, 60)}
              {replyTo.body.length > 60 ? "…" : ""}”
            </span>
            <button
              type="button"
              className="th-icon-btn"
              onClick={() => setReplyTo(null)}
              aria-label="Cancel reply"
            >
              <IconClose size={14} />
            </button>
          </div>
        )}
        <textarea
          ref={composerRef}
          className="vs-input th-textarea"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={me ? `Post to ${board} as @${me}…` : isAuthenticated ? "Set your page username (top of the page) to post…" : "Sign in with your wallet to post…"}
          rows={3}
          aria-label={`New post in ${board}`}
        />
        <div className="th-row">
          <button
            type="button"
            className="vs-btn vs-btn-primary th-btn-sm"
            onClick={submit}
            disabled={!body.trim() || !canWrite || hcs.phase.kind === "submitting"}
          >
            {hcs.phase.kind === "submitting" ? "Sign in wallet…" : "Post"}
          </button>
          {!canWrite && <span className="th-muted">{isAuthenticated ? "You need a page username to post." : "Sign in with your wallet to post."}</span>}
        </div>
        {postError && (
          <p className="th-error" role="alert" style={{ marginTop: 8 }}>
            {postError}{" "}
            <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={() => setPostError(null)}>
              Dismiss
            </button>
          </p>
        )}
        {hcs.phase.kind === "error" && (
          <p className="th-error">Failed to submit: {hcs.phase.message}</p>
        )}
        {hcs.phase.kind === "submitting" && hcs.waitingLong && (
          <p className="th-muted" role="status" style={{ marginTop: 8 }}>
            Still working — if you already approved in your wallet, the network is confirming.
            This can take up to ~90 seconds; please keep this page open.
          </p>
        )}
      </div>

      {loading && <p className="th-muted">Loading threads…</p>}
      {error && (
        <p className="th-error">
          Couldn&apos;t load posts: {error}{" "}
          <button type="button" className="th-identity-link" onClick={load}>
            retry
          </button>
        </p>
      )}
      {!loading && !error && threads.length === 0 && (
        <p className="th-muted">No posts yet — start the conversation.</p>
      )}
      <div className="th-post-list">
        {justPosted && (
          <p className="th-note" role="status" style={{ marginBottom: 8 }}>
            ✓ Posted — your post is live in the thread.
          </p>
        )}
        {threads.map((t) => (
          <Thread key={t.post.seq} node={t} depth={0} onReply={onReply} onHidden={load} />
        ))}
      </div>
    </>
  );
}
