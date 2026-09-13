"use client";

/**
 * <PostCard> — one town-hall post: author (links to their page), body,
 * timestamp, reply button, and a TIP button that runs the standard
 * tipPage(username) flow (98% creator / 2% treasury, enforced on-chain).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { tipPage, resolvePage } from "@/lib/contracts";
import { useWallet } from "@/lib/wallet";
import { getActiveChain } from "@/lib/chains";
import { getHbarUsdPrice } from "@/lib/x402";
import { usdToWei } from "@/lib/tokens";
import { timeAgo, type TownhallPost } from "@/lib/townhall";
import { IconTip, IconClose, IconCheck } from "@/components/icons";
import { useConfirmedTransaction } from "@/hooks/useConfirmedTransaction";
import { WalletTimeoutError } from "@/lib/tx";
import { recordConversionEvent } from "@/lib/metrics";
import { TxConfirming, TxReceipt, type TxReceiptLine } from "@/components/TxConfirm";
import ReputationBadge from "./Reputation";
import ModHideButton from "./ModHideButton";
import ReportButton from "./ReportButton";

const TIP_PRESETS = [1, 5, 10];

function TipModal({ author, onClose }: { author: string; onClose: () => void }) {
  const { account, getTxSender } = useWallet();
  const [usd, setUsd] = useState(5);
  const [price, setPrice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitingLong, setWaitingLong] = useState(false);
  const [txId, setTxId] = useState<string | null>(null);
  const [submittedTxId, setSubmittedTxId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once the wallet approves: the hook polls the mirror node until the
  // transaction reaches consensus, so the UI reacts to the real outcome.
  const [confirmTxId, setConfirmTxId] = useState<string | null>(null);
  const confirmStatus = useConfirmedTransaction(confirmTxId);
  // Finality clock: wallet approval → consensus, shown on the receipt.
  const [approvedAt, setApprovedAt] = useState<number | null>(null);
  const [finalizedAt, setFinalizedAt] = useState<Date | null>(null);
  const [receiptLines, setReceiptLines] = useState<TxReceiptLine[]>([]);
  const chain = getActiveChain();

  useEffect(() => {
    getHbarUsdPrice().then(setPrice).catch(() => setPrice(null));
  }, []);

  // Mirror-node verdict landed — move to the matching end state.
  useEffect(() => {
    if (!confirmTxId) return;
    if (confirmStatus === "confirmed") {
      setFinalizedAt(new Date());
      setTxId(confirmTxId);
      recordConversionEvent("tip_confirmed");
    } else if (confirmStatus === "failed") {
      setError("The transaction failed on-chain. No tip was sent.");
      recordConversionEvent("tip_failed");
    } else if (confirmStatus === "timeout") {
      // Submitted but not yet visible (mirror lag). Money may have moved —
      // never claim failure; show the honest "submitted" state.
      setSubmittedTxId(confirmTxId);
    }
  }, [confirmStatus, confirmTxId]);

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
    // Guardrail: never prompt a wallet signature for a doomed tip. The
    // contract reverts for unregistered pages — pre-check the registry
    // first so the user never signs a transaction that cannot succeed.
    setBusy(true);
    setWaitingLong(false);
    recordConversionEvent("tip_attempt");
    // HashPack sometimes goes silent after the user approves — reassure
    // after 15s so users don't abandon the page.
    const waitingNote = setTimeout(() => setWaitingLong(true), 15000);
    try {
      const registered = await resolvePage(author, getActiveChain());
      if (!registered) {
        setError(`@${author} isn't registered on-chain — the tip would fail.`);
        return;
      }
      const sender = await getTxSender();
      // Snapshot the breakdown for the success receipt — these amounts are
      // baked into the transaction, so they hold for every outcome path.
      const hbarAmt = usd / price;
      setReceiptLines([
        { label: "You sent", value: `$${usd} (≈ ${hbarAmt.toFixed(4)} HBAR)` },
        { label: `@${author} gets (98%)`, value: `≈ ${(hbarAmt * 0.98).toFixed(4)} HBAR` },
        { label: "Treasury gets (2%)", value: `≈ ${(hbarAmt * 0.02).toFixed(4)} HBAR` },
      ]);
      const id = await tipPage(author, usdToWei(usd, price), sender);
      // Approved — start the finality clock and confirm the real on-chain
      // outcome reactively.
      setApprovedAt(Date.now());
      setConfirmTxId(id);
    } catch (e) {
      if (e instanceof WalletTimeoutError) {
        // Wallet went silent after approval — don't guess; confirm on-chain.
        setApprovedAt(Date.now());
        setConfirmTxId(e.txId);
      } else {
        setError(`Tip failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      clearTimeout(waitingNote);
      setBusy(false);
      setWaitingLong(false);
    }
  };

  const reset = () => {
    setTxId(null);
    setSubmittedTxId(null);
    setConfirmTxId(null);
    setApprovedAt(null);
    setFinalizedAt(null);
    setReceiptLines([]);
    setError(null);
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
          <TxReceipt
            title="Tip confirmed"
            approvedAt={approvedAt}
            finalizedAt={finalizedAt}
            txId={txId}
            explorerBase={chain.blockExplorer}
            lines={receiptLines}
            nextStep={`It's live on @${author}'s page — they'll see your tip right away.`}
            onAgain={reset}
            onDone={onClose}
          />
        ) : submittedTxId ? (
          <div className="th-tip-done">
            <IconCheck size={28} />
            <p>
              Tip of ${usd} submitted to @{author}. It&apos;s still being confirmed on-chain —
              check HashScan in a minute to see it land.
            </p>
            <p className="vs-mono th-tx">{submittedTxId}</p>
            <a
              className="th-identity-link"
              href={`${chain.blockExplorer}/transaction/${submittedTxId}`}
              target="_blank"
              rel="noreferrer"
            >
              View on HashScan
            </a>
            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={reset}>
                Tip again
              </button>
              <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={onClose}>
                Done
              </button>
            </div>
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
              disabled={busy || confirmStatus === "confirming"}
            >
              <IconTip size={18} />{" "}
              {confirmStatus === "confirming"
                ? "Confirming on Hedera…"
                : busy
                  ? "Tipping…"
                  : `Tip $${usd}`}
            </button>
            {busy && waitingLong && (
              <p className="th-muted" role="status">
                Still working — if you already approved in your wallet, the network is confirming.
                This can take up to ~90 seconds; please keep this page open.
              </p>
            )}
            {confirmStatus === "confirming" && (
              <div style={{ marginTop: 4 }}>
                <TxConfirming sub="Approved in your wallet — waiting for Hedera to reach consensus (usually a few seconds)." />
              </div>
            )}
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
        {(post as { pending?: boolean }).pending && (
          <span className="th-muted" title="Sent to Hedera — waiting for network confirmation">
            {" "}◌ confirming…
          </span>
        )}
        {(post as { unconfirmed?: boolean }).unconfirmed && (
          <span className="th-muted" title="Not confirmed on-chain yet — the message may still arrive">
            {" "}⚠ not yet confirmed — pull to refresh
          </span>
        )}
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
        <ReportButton targetKind="post" targetSeq={post.seq} />
      </div>
      {tipping && <TipModal author={post.author} onClose={() => setTipping(false)} />}
    </article>
  );
}
