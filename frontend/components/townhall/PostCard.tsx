"use client";

/**
 * <PostCard> — one town-hall post: author (links to their page), body,
 * timestamp, reply button, and a TIP button that runs the standard
 * tipPage(username) flow (98% creator / 2% treasury, enforced on-chain).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { tipPage, resolvePage } from "@/lib/contracts";
import { friendlyWalletError, useWallet } from "@/lib/wallet";
import { getActiveChain } from "@/lib/chains";
import { getHbarUsdPrice } from "@/lib/x402";
import { usdToWei, hbarToWei } from "@/lib/tokens";
import {
  TIP_CURRENCY_KEY,
  TIP_PANEL_EVENT,
  readTipCurrency,
  type TipCurrency,
} from "@/lib/tip-currency";
import { timeAgo, type TownhallPost } from "@/lib/townhall";
import { IconTip, IconClose, IconCheck } from "@/components/icons";
import { useConfirmedTransaction } from "@/hooks/useConfirmedTransaction";
import { WalletTimeoutError } from "@/lib/tx";
import { recordConversionEvent } from "@/lib/metrics";
import { TxConfirming, TxReceipt, type TxReceiptLine } from "@/components/TxConfirm";
import TipCelebration from "@/components/TipCelebration";
import ReputationBadge from "./Reputation";
import AgentMark from "@/components/AgentMark";
import ModHideButton from "./ModHideButton";
import ReportButton from "./ReportButton";

const TIP_PRESETS = [1, 5, 10];
const TIP_PRESETS_HBAR = [1, 5, 10, 25, 50];

function TipModal({ author, onClose }: { author: string; onClose: () => void }) {
  const { account, getTxSender } = useWallet();
  const [usd, setUsd] = useState(5);
  // Visitor-chosen tip currency, shared with the blockpage tip panel.
  const [currency, setCurrency] = useState<TipCurrency>(() => readTipCurrency());
  const [hbarAmount, setHbarAmount] = useState(5);
  const isHbar = currency === "hbar";
  useEffect(() => {
    try {
      window.localStorage.setItem(TIP_CURRENCY_KEY, currency);
    } catch {
      // Private mode etc. — the toggle still works for this visit.
    }
  }, [currency]);
  // Let the floating Buddy button hide while a tip panel is open.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(TIP_PANEL_EVENT, { detail: true }));
    return () => {
      window.dispatchEvent(new CustomEvent(TIP_PANEL_EVENT, { detail: false }));
    };
  }, []);
  const [price, setPrice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
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
      recordConversionEvent("tip_confirmed", "post");
    } else if (confirmStatus === "failed") {
      setError("The transaction failed on-chain. No tip was sent.");
      recordConversionEvent("tip_failed", "post");
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
    // USD mode needs the price feed to convert; HBAR mode is exact.
    const p = price;
    if (!isHbar && p == null) {
      setError("HBAR price is still loading — try again in a moment.");
      return;
    }
    // Guardrail: never prompt a wallet signature for a doomed tip. The
    // contract reverts for unregistered pages — pre-check the registry
    // first so the user never signs a transaction that cannot succeed.
    setBusy(true);
    recordConversionEvent("tip_attempt", "post");
    try {
      const registered = await resolvePage(author, getActiveChain());
      if (!registered) {
        setError(`@${author} isn't registered on-chain — the tip would fail.`);
        return;
      }
      const sender = await getTxSender();
      // Snapshot the breakdown for the success receipt — these amounts are
      // baked into the transaction, so they hold for every outcome path.
      const hbarAmt = isHbar ? hbarAmount : usd / (p as number);
      setReceiptLines(
        isHbar
          ? [
              { label: "You sent", value: `${hbarAmount} HBAR` },
              { label: `@${author} gets (98%)`, value: `${(hbarAmt * 0.98).toFixed(4)} HBAR` },
              { label: "Treasury gets (2%)", value: `${(hbarAmt * 0.02).toFixed(4)} HBAR` },
            ]
          : [
              { label: "You sent", value: `$${usd} (≈ ${hbarAmt.toFixed(4)} HBAR)` },
              { label: `@${author} gets (98%)`, value: `≈ ${(hbarAmt * 0.98).toFixed(4)} HBAR` },
              { label: "Treasury gets (2%)", value: `≈ ${(hbarAmt * 0.02).toFixed(4)} HBAR` },
            ],
      );
      const id = await tipPage(author, isHbar ? hbarToWei(hbarAmount) : usdToWei(usd, p as number), sender);
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
        // Wallet-side failure (rejection, wallet-library error): record the
        // outcome so the funnel never shows a bare attempt, and map known
        // wallet-library TypeErrors to actionable copy.
        setError(`Tip failed: ${friendlyWalletError(e)}`);
        recordConversionEvent("tip_failed", "post");
      }
    } finally {
      setBusy(false);
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
          <>
            <TipCelebration
              usd={isHbar ? `${hbarAmount} HBAR` : `$${usd.toFixed(2)}`}
              hbar={isHbar ? null : price ? (usd / price).toFixed(4) : null}
              username={author}
            />
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
          </>
        ) : submittedTxId ? (
          <div className="th-tip-done">
            <IconCheck size={28} />
            <p>
              Tip of {isHbar ? `${hbarAmount} HBAR` : `$${usd}`} submitted to @{author}. It&apos;s still being confirmed on-chain —
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
            <div className="th-cur-toggle" role="group" aria-label="Tip currency">
              {(["usd", "hbar"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`th-cur${currency === c ? " is-active" : ""}`}
                  aria-pressed={currency === c}
                  onClick={() => setCurrency(c)}
                >
                  {c === "usd" ? "USD" : "HBAR"}
                </button>
              ))}
            </div>
            <div className="th-chip-row" role="group" aria-label="Tip amount">
              {(isHbar ? TIP_PRESETS_HBAR : TIP_PRESETS).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`th-chip${(isHbar ? hbarAmount : usd) === p ? " is-active" : ""}`}
                  onClick={() => (isHbar ? setHbarAmount(p) : setUsd(p))}
                >
                  {isHbar ? `${p} ℏ` : `$${p}`}
                </button>
              ))}
            </div>
            <p className="th-muted">
              {isHbar
                ? `${hbarAmount} HBAR`
                : price
                  ? `≈ ${(usd / price).toFixed(4)} HBAR`
                  : "Loading HBAR price…"}
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
                  : isHbar
                    ? `Tip ${hbarAmount} HBAR`
                    : `Tip $${usd}`}
            </button>
            {busy && !confirmTxId && (
              <TxConfirming
                title="Waiting on your wallet…"
                sub="Waiting for your wallet to return the transaction. Keep this page open. If you already approved, Voicescape will keep checking for the result."
              />
            )}
            {confirmStatus === "confirming" && (
              <div style={{ marginTop: 4 }}>
                <TxConfirming
                  sub="Approved in your wallet — waiting for Hedera to reach consensus (usually a few seconds)."
                  txId={confirmTxId}
                  explorerBase={chain.blockExplorer}
                />
              </div>
            )}
            {error && (
              <p className="th-error">
                {error}{" "}
                <a
                  href="https://discord.gg/2KGzPduUN5"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Need help? Get support on Discord →
                </a>
              </p>
            )}
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
        <AgentMark username={post.author} />
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
