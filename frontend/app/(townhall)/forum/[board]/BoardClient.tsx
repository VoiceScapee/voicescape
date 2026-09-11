"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PostCard from "@/components/townhall/PostCard";
import DustFeeGate from "@/components/townhall/DustFeeGate";
import { PresenceDot } from "@/components/townhall/Presence";
import { useDustFee, useWriteGate } from "@/components/townhall/useTownhall";
import { useStreamEvents } from "@/components/townhall/useStream";
import { getJson, postJson, type TownhallPost } from "@/lib/townhall";
import { IconClose } from "@/components/icons";

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
  const dust = useDustFee();
  const [posts, setPosts] = useState<TownhallPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<TownhallPost | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

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
      return [...fresh, ...prev].slice(0, 300);
    });
  }, []);

  const streamUrl = `/api/townhall/posts/stream?board=${encodeURIComponent(board)}`;
  const streamConn = useStreamEvents<TownhallPost>(
    streamUrl,
    (events) => mergePosts(events.map(normalizePost)),
    isPostView,
  );

  const threads = useMemo(() => buildThreads(posts), [posts]);

  const onReply = useCallback((p: TownhallPost) => {
    setReplyTo(p);
    composerRef.current?.focus();
    composerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const submit = async () => {
    const text = body.trim();
    if (!text || !canWrite) return;
    const replySeq = replyTo?.seq ?? null;
    let sentSeq: number | null = null;
    const ok = await dust.execute(async (dustFeeTxId) => {
      const res = await postJson<{ seq: number }>("/api/townhall/posts", {
        board,
        body: text,
        replyTo: replySeq,
        author: me,
        dustFeeTxId,
      });
      sentSeq = res.seq;
    });
    if (ok) {
      setBody("");
      setReplyTo(null);
      // Optimistic: show it now; the stream dedupes when the real copy arrives.
      if (sentSeq != null && me) {
        mergePosts([
          { seq: sentSeq, board, wall: undefined, author: me, body: text, replyTo: replySeq, ts: Date.now() },
        ]);
      }
    }
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
            disabled={!body.trim() || !canWrite || dust.phase.kind === "working" || dust.phase.kind === "paying"}
          >
            {dust.phase.kind === "working" || dust.phase.kind === "paying" ? "Posting…" : "Post"}
          </button>
          {!canWrite && <span className="th-muted">{isAuthenticated ? "You need a page username to post." : "Sign in with your wallet to post."}</span>}
        </div>
        <DustFeeGate flow={dust} actionLabel="post" />
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
        {threads.map((t) => (
          <Thread key={t.post.seq} node={t} depth={0} onReply={onReply} onHidden={load} />
        ))}
      </div>
    </>
  );
}
