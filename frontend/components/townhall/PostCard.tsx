"use client";

/**
 * <PostCard> — one town-hall post: author (links to their page), body,
 * timestamp, reply button, and a TIP button that runs the standard
 * tipPage(username) flow (98% creator / 2% treasury, enforced on-chain).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { tipPage } from "@/lib/contracts";
import { useWallet } from "@/lib/wallet";
import { getHbarUsdPrice } from "@/lib/x402";
import { usdToWei } from "@/lib/tokens";
import { timeAgo, type TownhallPost } from "@/lib/townhall";
import { IconTip, IconClose, IconCheck } from "@/components/icons";
import ReputationBadge from "./Reputation";
import ModHideButton from "./ModHideButton";

const TIP_PRESETS = [1, 5, 10];

function TipModal({ author, onClose }: { author: string; onClose: () => void }) {
  const { account, getTxSender } = useWallet();
  const [usd, setUsd] = useState(5);
  const [price, setPrice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [txId, setTxId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getHbarUsdPrice().then(setPrice).catch(() => setPrice(null));
  }, []);

  const tip = async () => {
    setError(null);
    if (!account) {
      setError("Connect a wallet to tip.");
      return;
    }
    if (!price) {
      setError("HBAR price is still loading — try again in a moment.");
      return;
    }
    setBusy(true);
    try {
      const sender = await getTxSender();
      const id = await tipPage(author, usdToWei(usd, price), sender);
      setTxId(id);
    } catch (e) {
      setError(`Tip failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="th-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Tip ${author}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="th-modal">
        <div className="th-modal-head">
          <h3>
            <IconTip size={18} /> Tip @{author}
          </h3>
          <button type="button" className="th-icon-btn" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        {txId ? (
          <div className="th-tip-done">
            <IconCheck size={28} />
            <p>Tip sent — 98% to @{author}, 2% to the treasury, enforced on-chain.</p>
            <p className="vs-mono th-tx">{txId}</p>
            <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="th-chip-row" role="group" aria-label="Tip amount">
              {TIP_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`th-chip${usd === p ? " is-active" : ""}`}
                  onClick={() => setUsd(p)}
                >
                  ${p}
                </button>
              ))}
            </div>
            <p className="th-muted">
              {price ? `≈ ${(usd / price).toFixed(4)} HBAR` : "Loading HBAR price…"}
            </p>
            <button
              type="button"
              className="vs-btn vs-btn-primary th-btn-block"
              onClick={tip}
              disabled={busy}
            >
              <IconTip size={18} /> {busy ? "Tipping…" : `Tip $${usd}`}
            </button>
            {error && <p className="th-error">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}

export default function PostCard({
  post,
  onReply,
  depth = 0,
  onHidden,
}: {
  post: TownhallPost;
  onReply?: (post: TownhallPost) => void;
  depth?: number;
  /**
   * When provided, a moderator Hide button is shown (only to authorized
   * moderators, per /api/townhall/mod-status) and this callback runs after
   * a successful hide so the parent can reload.
   */
  onHidden?: () => void;
}) {
  const [tipping, setTipping] = useState(false);

  return (
    <article className="th-post" style={depth > 0 ? { marginLeft: Math.min(depth, 3) * 14 } : undefined}>
      <div className="th-post-head">
        <Link href={`/${post.author}`} className="th-post-author">
          @{post.author}
        </Link>
        <ReputationBadge username={post.author} compact />
        <span className="th-post-ts" title={new Date(post.ts).toLocaleString()}>
          {timeAgo(post.ts)}
        </span>
      </div>
      <p className="th-post-body">{post.body}</p>
      <div className="th-post-actions">
        {onReply && (
          <button type="button" className="th-action" onClick={() => onReply(post)}>
            Reply
          </button>
        )}
        <button type="button" className="th-action is-tip" onClick={() => setTipping(true)}>
          <IconTip size={14} /> Tip
        </button>
        {onHidden && <ModHideButton post={post} onHidden={onHidden} />}
      </div>
      {tipping && <TipModal author={post.author} onClose={() => setTipping(false)} />}
    </article>
  );
}
