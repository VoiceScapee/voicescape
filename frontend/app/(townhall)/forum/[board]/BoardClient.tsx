"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PostCard from "@/components/townhall/PostCard";
import DustFeeGate from "@/components/townhall/DustFeeGate";
import { useDustFee, useWriteGate } from "@/components/townhall/useTownhall";
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
      setPosts(Array.isArray(data.posts) ? data.posts : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [board]);

  useEffect(() => {
    load();
  }, [load]);

  const threads = useMemo(() => buildThreads(posts), [posts]);

  const onReply = useCallback((p: TownhallPost) => {
    setReplyTo(p);
    composerRef.current?.focus();
    composerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const submit = async () => {
    const text = body.trim();
    if (!text || !canWrite) return;
    const ok = await dust.execute(async (dustFeeTxId) => {
      await postJson<{ seq: number }>("/api/townhall/posts", {
        board,
        body: text,
        replyTo: replyTo?.seq ?? null,
        author: me,
        dustFeeTxId,
      });
    });
    if (ok) {
      setBody("");
      setReplyTo(null);
      load();
    }
  };

  return (
    <>
      <div className="th-page-head">
        <h1>{board}</h1>
        <p>Newest threads first — reply inline, tip posts you like.</p>
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
