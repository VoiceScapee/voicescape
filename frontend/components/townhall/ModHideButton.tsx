"use client";

/**
 * <ModHideButton> — Hide control for a forum post, rendered only when the
 * signed-in page owner is authorized to moderate it: a global mod
 * (TOWNHALL_MODS) anywhere, or the wall owner on their own wall.
 *
 * Posts a mod-action to /api/townhall/mod-actions (session-gated
 * server-side), then asks the parent to reload — the hidden post is
 * filtered out of reads for everyone. Hides are permanent in v1 (HCS is
 * append-only; there is no unhide action).
 */
import { useEffect, useState } from "react";
import { useWriteGate } from "./useTownhall";
import { useHcsSubmit } from "./useHcsSubmit";
import { getJson, postJson, type TownhallPost } from "@/lib/townhall";

export default function ModHideButton({
  post,
  onHidden,
}: {
  post: TownhallPost;
  onHidden: () => void;
}) {
  const { username: me, isAuthenticated, sessionReady } = useWriteGate();
  const hcs = useHcsSubmit();
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionReady || !isAuthenticated || !me) {
      setAllowed(false);
      return;
    }
    let live = true;
    const wall = post.wall ? `&wall=${encodeURIComponent(post.wall)}` : "";
    getJson<{ isMod?: boolean; canModerateWall?: boolean }>(
      `/api/townhall/mod-status?username=${encodeURIComponent(me)}${wall}`,
    )
      .then((d) => {
        if (live) setAllowed(!!d.isMod || !!d.canModerateWall);
      })
      .catch(() => {
        if (live) setAllowed(false);
      });
    return () => {
      live = false;
    };
  }, [sessionReady, isAuthenticated, me, post.wall]);

  if (!allowed) return null;

  const hide = async () => {
    if (busy) return;
    if (
      !window.confirm(
        `Hide @${post.author}'s post? It stays on HCS but is filtered from reads for everyone.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      // Mod signs the hide action via their wallet first (transparent on-chain).
      const hcsTxId = await hcs.submit("forum", {
        v: 1,
        kind: "mod-action",
        ts: new Date().toISOString(),
        author: me,
        targetKind: "post",
        board: post.board,
        wall: post.wall ?? null,
        targetSeq: post.seq,
        action: "hide",
      });
      if (!hcsTxId) return; // User cancelled or error — phase shows the error
      await postJson<{ seq: number }>("/api/townhall/mod-actions", {
        author: me,
        targetKind: "post",
        targetSeq: post.seq,
        board: post.board,
        wall: post.wall ?? null,
        hcsTxId,
      });
      onHidden();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitting = busy || hcs.phase.kind === "submitting";

  return (
    <span className="th-modhide">
      <button
        type="button"
        className="th-action is-danger"
        onClick={hide}
        disabled={submitting}
        title="Hide this post (moderator)"
      >
        {submitting ? "Sign in wallet…" : "Hide"}
      </button>
      {error && <span className="th-error">{error}</span>}
      {hcs.phase.kind === "error" && <span className="th-error">Failed to submit: {hcs.phase.message}</span>}
    </span>
  );
}
