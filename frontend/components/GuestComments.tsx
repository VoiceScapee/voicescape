"use client";

/**
 * <GuestComments page thread?> — no-login comments that persist.
 *
 * Reads/writes /api/guest-comments/<page>/<thread>. Guests post with a
 * self-asserted name (labelled Guest, no wallet, no fee); the server
 * rejects reserved/registered names and rate-limits per IP. Replies are
 * two levels deep: a reply to a reply attaches to the same top-level
 * comment. The page owner sees a Hide button (server-enforced, signed
 * session) when `canModerate` comes back true.
 */
import { useCallback, useEffect, useState } from "react";
import { getAuthHeaders } from "@/lib/auth-client";

interface GuestCommentView {
  id: number;
  name: string;
  body: string;
  parentId: number | null;
  ts: number;
}

export default function GuestComments({
  page,
  thread = "general",
  title,
}: {
  page: string;
  thread?: string;
  title?: string;
}) {
  const [comments, setComments] = useState<GuestCommentView[]>([]);
  const [canModerate, setCanModerate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<{ id: number; name: string } | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [justPosted, setJustPosted] = useState(false);

  const url = `/api/guest-comments/${encodeURIComponent(page)}/${encodeURIComponent(thread)}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : "couldn't load comments");
      setComments(Array.isArray(data.comments) ? data.comments : []);
      setCanModerate(data.canModerate === true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    load();
  }, [load]);

  // Replies attach to the top-level ancestor, so threads stay two levels deep.
  const topAncestorId = (id: number): number => {
    const byId = new Map(comments.map((c) => [c.id, c]));
    let cur = byId.get(id);
    while (cur && cur.parentId !== null) {
      const parent = byId.get(cur.parentId);
      if (!parent) break;
      cur = parent;
    }
    return cur ? cur.id : id;
  };

  const submit = async () => {
    const cleanName = name.trim();
    const cleanBody = body.trim();
    if (!cleanName || !cleanBody || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          name: cleanName,
          body: cleanBody,
          parentId: replyTo ? topAncestorId(replyTo.id) : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : "couldn't post your comment");
      setBody("");
      setReplyTo(null);
      setJustPosted(true);
      setTimeout(() => setJustPosted(false), 8000);
      await load();
    } catch (e) {
      setPostError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  };

  const hide = async (id: number) => {
    try {
      const res = await fetch(`${url}/hide`, {
        method: "POST",
        headers: { "content-type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data?.error === "string" ? data.error : "couldn't hide that comment");
      }
      await load();
    } catch (e) {
      setPostError(e instanceof Error ? e.message : String(e));
    }
  };

  const topLevel = comments.filter((c) => c.parentId === null);
  const repliesOf = (id: number) => comments.filter((c) => c.parentId === id);

  const renderComment = (c: GuestCommentView, depth: number) => (
    <article key={c.id} className={`pv-guest-card${depth > 0 ? " pv-guest-reply" : ""}`}>
      <div className="pv-guest-meta">
        <span className="pv-guest-name">{c.name}</span>
        <span className="pv-guest-badge">Guest</span>
        <span className="pv-guest-date vs-mono">{new Date(c.ts).toLocaleString()}</span>
      </div>
      <p>{c.body}</p>
      <div className="pv-guest-actions">
        <button
          type="button"
          className="vs-btn vs-btn-ghost th-btn-sm"
          onClick={() => setReplyTo({ id: c.id, name: c.name })}
        >
          Reply
        </button>
        {canModerate && (
          <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={() => hide(c.id)}>
            Hide
          </button>
        )}
      </div>
    </article>
  );

  return (
    <section className="pv-block" aria-label={title || "Guest comments"}>
      <h2 className="pv-block-title">
        <span aria-hidden="true">💬</span>
        <span>{title || "Guest comments"}</span>
      </h2>
      <p className="pv-guest-note">
        No sign-in needed — you&apos;re posting as a guest. Please don&apos;t use someone
        else&apos;s page name.
      </p>

      <div className="pv-guest-form">
        <input
          className="vs-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          maxLength={24}
          aria-label="Your name"
        />
        <textarea
          className="vs-input"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Say something nice…"
          rows={2}
          maxLength={500}
          aria-label="Your comment"
        />
        {replyTo && (
          <p className="pv-guest-replying" role="status">
            Replying to {replyTo.name}{" "}
            <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={() => setReplyTo(null)}>
              Cancel
            </button>
          </p>
        )}
        <div>
          <button
            type="button"
            className="vs-btn vs-btn-primary"
            onClick={submit}
            disabled={posting || !name.trim() || !body.trim()}
          >
            {posting ? "Posting…" : "Post comment"}
          </button>
        </div>
        {postError && (
          <p className="th-error" role="alert">
            {postError}{" "}
            <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={() => setPostError(null)}>
              Dismiss
            </button>
          </p>
        )}
      </div>

      {loading && <p className="pv-empty">Loading comments…</p>}
      {error && (
        <p className="th-error">
          Couldn&apos;t load comments: {error}{" "}
          <button type="button" className="th-identity-link" onClick={load}>
            retry
          </button>
        </p>
      )}
      {!loading && !error && comments.length === 0 && (
        <p className="pv-empty">Be the first to say hi.</p>
      )}
      {justPosted && (
        <p className="th-note" role="status">
          ✓ Posted — your comment is now live here.
        </p>
      )}
      <div className="pv-guest-list">
        {topLevel.map((c) => (
          <div key={c.id}>
            {renderComment(c, 0)}
            {repliesOf(c.id).map((r) => renderComment(r, 1))}
          </div>
        ))}
      </div>
    </section>
  );
}
