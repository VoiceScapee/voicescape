"use client";

/**
 * <ModHideButton> — Hide control for a forum post, rendered only when the
 * signed-in page owner is authorized to moderate it: a global mod
 * (TOWNHALL_MODS) anywhere, or the wall owner on their own wall.
 *
 * Confirmation is an in-app modal (NOT window.confirm): wallet in-app
 * browsers (e.g. HashPack's WebView) commonly suppress native JS dialogs,
 * which made the Hide button appear to do nothing at all.
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
import { TIP_PANEL_EVENT } from "@/lib/tip-currency";
import { IconClose } from "@/components/icons";

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
  const [confirming, setConfirming] = useState(false);
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

  // Let the floating Buddy button hide while the confirm modal is open.
  useEffect(() => {
    if (!confirming) return;
    window.dispatchEvent(new CustomEvent(TIP_PANEL_EVENT, { detail: true }));
    return () => {
      window.dispatchEvent(new CustomEvent(TIP_PANEL_EVENT, { detail: false }));
    };
  }, [confirming]);

  if (!allowed) return null;

  const openConfirm = () => {
    if (busy) return;
    setError(null);
    setConfirming(true);
  };

  const closeConfirm = () => {
    if (busy) return;
    setConfirming(false);
  };

  const hide = async () => {
    if (busy) return;
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
      if (!hcsTxId) return; // User cancelled or error — phase shows the error; modal stays open to retry/cancel
      await postJson<{ seq: number }>("/api/townhall/mod-actions", {
        author: me,
        targetKind: "post",
        targetSeq: post.seq,
        board: post.board,
        wall: post.wall ?? null,
        hcsTxId,
      });
      setConfirming(false);
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
        onClick={openConfirm}
        disabled={submitting}
        title="Hide this post (moderator)"
      >
        {submitting && !confirming ? "Sign in wallet…" : "Hide"}
      </button>
      {error && !confirming && <span className="th-error">{error}</span>}
      {hcs.phase.kind === "error" && !confirming && (
        <span className="th-error">Failed to submit: {hcs.phase.message}</span>
      )}
      {confirming && (
        <div
          className="th-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Hide @${post.author}'s post`}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeConfirm();
          }}
        >
          <div className="th-modal">
            <div className="th-modal-head">
              <h3>Hide post?</h3>
              <button
                type="button"
                className="th-icon-btn"
                onClick={closeConfirm}
                aria-label="Close"
                disabled={submitting}
              >
                <IconClose size={16} />
              </button>
            </div>
            <p style={{ margin: "0 0 4px" }}>
              Hide <strong>@{post.author}</strong>&apos;s post? It stays on HCS but is
              filtered from reads for everyone.
            </p>
            <p className="th-muted" style={{ margin: "0 0 12px", fontSize: "0.85rem" }}>
              This can&apos;t be undone — hides are permanent.
            </p>
            {error && (
              <p className="th-error" role="alert">
                {error}
              </p>
            )}
            {hcs.phase.kind === "error" && (
              <p className="th-error" role="alert">
                Failed to submit: {hcs.phase.message}
              </p>
            )}
            {submitting && (
              <p className="th-muted" role="status" style={{ marginBottom: 8 }}>
                Sign in your wallet to approve the hide…
              </p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="vs-btn vs-btn-ghost th-btn-sm"
                style={{ flex: 1 }}
                onClick={closeConfirm}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="vs-btn vs-btn-primary th-btn-sm"
                style={{ flex: 1 }}
                onClick={hide}
                disabled={submitting}
              >
                {submitting ? "Hiding…" : "Hide post"}
              </button>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
