"use client";

/**
 * <TipModal> — the standard Voicescape tip flow for a username.
 *
 * Amount presets (USD/HBAR), wallet connect, tipPage(username) contract call
 * (98% creator / 2% treasury, enforced on-chain), mirror-node confirmation,
 * and the success receipt. Used by town-hall posts and by the embeddable
 * tip widget (/embed/tip/[username]).
 *
 * Extracted verbatim from components/townhall/PostCard.tsx; the only
 * additions are the display-only `inline` and `initialAmount` props.
 */
import { useEffect, useMemo, useState } from "react";
import { consensusTimestampToDate } from "@/lib/tx-confirm";
import { tipPage, resolvePage } from "@/lib/contracts";
import {
  friendlyWalletError,
  isStaleConnectionError,
  repairStaleConnection,
  useWallet,
  WALLET_ADAPTERS,
} from "@/lib/wallet";
import { useSession } from "@/lib/session";
import { getActiveChain } from "@/lib/chains";
import { getHbarUsdPrice } from "@/lib/x402";
import { usdToWei, hbarToWei } from "@/lib/tokens";
import {
  TIP_CURRENCY_KEY,
  TIP_PANEL_EVENT,
  readTipCurrency,
  type TipCurrency,
} from "@/lib/tip-currency";
import { IconTip, IconClose, IconCheck } from "@/components/icons";
import { useConfirmedTransaction } from "@/hooks/useConfirmedTransaction";
import { WalletTimeoutError } from "@/lib/tx";
import { recordConversionEvent } from "@/lib/metrics";
import { reportError } from "@/lib/report-error";
import { TxConfirming, TxReceipt, type TxReceiptLine } from "@/components/TxConfirm";
import TipCelebration from "@/components/TipCelebration";
import { useDialogA11y } from "@/components/useDialogA11y";

const TIP_PRESETS = [1, 5, 10];
const TIP_PRESETS_HBAR = [1, 5, 10, 25, 50];

export default function TipModal({
  author,
  onClose,
  inline = false,
  initialAmount,
}: {
  author: string;
  onClose: () => void;
  /**
   * Render the bare tip panel with no overlay or close chrome. Used by the
   * embeddable tip widget (/embed/tip/[username]). The tip flow is identical.
   */
  inline?: boolean;
  /**
   * Preselect a tip amount (USD). Display default only — the tip flow,
   * presets, and the on-chain 98/2 split are unchanged.
   */
  initialAmount?: number;
}) {
  const { account, connect, getTxSender } = useWallet();
  const { session, signOut } = useSession();
  // Dialog a11y (Escape, focus trap, focus return, scroll lock) — overlay
  // only; the inline embed render is not a dialog.
  const dialogRef = useDialogA11y(onClose, !inline);
  // Optional preselected amount (embed ?amount=). Clamped 1..1000; null
  // keeps the existing default. Never touches amounts sent on-chain beyond
  // what the visitor explicitly confirms.
  const presetAmount =
    initialAmount != null && Number.isFinite(initialAmount)
      ? Math.min(1000, Math.max(1, Math.round(initialAmount)))
      : null;
  const [usd, setUsd] = useState(presetAmount ?? 5);
  // Visitor-chosen tip currency, shared with the blockpage tip panel.
  const [currency, setCurrency] = useState<TipCurrency>(() => readTipCurrency());
  const [hbarAmount, setHbarAmount] = useState(presetAmount ?? 5);
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
  const [repairing, setRepairing] = useState(false);
  const [txId, setTxId] = useState<string | null>(null);
  const [submittedTxId, setSubmittedTxId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One-tap fix for a stale WalletConnect session — same pattern as the
  // blockpage tip modal: only shown when the error means the pairing died.
  const staleConnection = isStaleConnectionError(error);
  const repairConnection = async () => {
    // Capture the adapter BEFORE signOut() clears the session.
    const stored = WALLET_ADAPTERS.find((a) => a.id === (session?.adapterId ?? "hashpack"));
    const adapterId = stored ? stored.id : "hashpack";
    setRepairing(true);
    setError(null);
    try {
      await repairStaleConnection({ signOut, connect, adapterId });
      // Success: error stays cleared; the user taps Tip again deliberately.
    } catch (e) {
      setError(`Couldn't reconnect — ${friendlyWalletError(e)}`);
    } finally {
      setRepairing(false);
    }
  };
  // Set once the wallet approves: the hook polls the mirror node until the
  // transaction reaches consensus, so the UI reacts to the real outcome.
  const [confirmTxId, setConfirmTxId] = useState<string | null>(null);
  // Finality clock: wallet approval → consensus, shown on the receipt.
  const [approvedAt, setApprovedAt] = useState<number | null>(null);
  const [finalizedAt, setFinalizedAt] = useState<Date | null>(null);
  // The receipt shows the network-assigned consensus timestamp, not the
  // device clock — first-principles fair timing.
  const confirmOpts = useMemo(
    () => ({
      onConsensus: (ts: string | null) =>
        setFinalizedAt(consensusTimestampToDate(ts ?? "") ?? new Date()),
    }),
    [],
  );
  const confirmStatus = useConfirmedTransaction(confirmTxId, confirmOpts);
  const [receiptLines, setReceiptLines] = useState<TxReceiptLine[]>([]);
  const chain = getActiveChain();

  const [priceFailed, setPriceFailed] = useState(false);
  useEffect(() => {
    getHbarUsdPrice()
      .then((p) => {
        setPrice(p);
        setPriceFailed(p === null);
      })
      .catch(() => {
        setPrice(null);
        setPriceFailed(true);
      });
  }, []);

  // Mirror-node verdict landed — move to the matching end state.
  useEffect(() => {
    if (!confirmTxId) return;
    if (confirmStatus === "confirmed") {
      // onConsensus already set the network timestamp; keep it — only fall
      // back to the device clock if it somehow didn't fire.
      setFinalizedAt((prev) => prev ?? new Date());
      setTxId(confirmTxId);
      recordConversionEvent("tip_confirmed", "post");
    } else if (confirmStatus === "failed") {
      setError("The transaction failed on-chain. No tip was sent.");
      recordConversionEvent("tip_failed", "post");
    } else if (confirmStatus === "expired") {
      // The mirror has indexed past this transaction's validity window
      // without seeing it: it can never land, no tip was sent, and retrying
      // with a fresh transaction is safe.
      setError(
        "The transaction never reached the Hedera network — no tip was sent and it's safe to retry.",
      );
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
      setError(
        priceFailed
          ? "HBAR price is unavailable right now — switch to HBAR mode to tip the exact amount."
          : "HBAR price is still loading — try again in a moment.",
      );
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
      // Integer tinybar math mirrors the contract's 98/2 split exactly —
      // never float multiplication for money display.
      const receiptTiny = BigInt(Math.round(hbarAmt * 1e8));
      const receiptCreator = Number((receiptTiny * 98n) / 100n) / 1e8;
      const receiptTreasury = Number((receiptTiny * 2n) / 100n) / 1e8;
      setReceiptLines(
        isHbar
          ? [
              { label: "You sent", value: `${hbarAmount} HBAR` },
              { label: `@${author} gets (98%)`, value: `${receiptCreator.toFixed(4)} HBAR` },
              { label: "Treasury gets (2%)", value: `${receiptTreasury.toFixed(4)} HBAR` },
            ]
          : [
              { label: "You sent", value: `$${usd} (≈ ${hbarAmt.toFixed(4)} HBAR)` },
              { label: `@${author} gets (98%)`, value: `≈ ${receiptCreator.toFixed(4)} HBAR` },
              { label: "Treasury gets (2%)", value: `≈ ${receiptTreasury.toFixed(4)} HBAR` },
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
        // outcome so the funnel never shows a bare attempt, report the
        // reason, and map known wallet-library TypeErrors to actionable copy.
        reportError(e, "post-tip", { action: "tip-submit", walletState: account ? "connected" : "disconnected" });
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

  // One panel, two shells: the overlay dialog for in-app (town hall) use,
  // the bare panel for the embeddable widget. The tip flow is identical.
  const panel = (
      <div className={`th-modal${inline ? " th-modal-inline" : ""}`}>
        <div className="th-modal-head">
          <h3>
            <IconTip size={18} /> Tip @{author}
          </h3>
          {!inline && (
            <button type="button" className="th-icon-btn" onClick={onClose} aria-label="Close">
              <IconClose size={16} />
            </button>
          )}
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
                  : priceFailed
                    ? "Price unavailable — HBAR mode works"
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
                {staleConnection && (
                  <>
                    <button
                      type="button"
                      onClick={repairConnection}
                      disabled={repairing}
                      style={{ marginLeft: 8 }}
                    >
                      {repairing ? "Repairing…" : "🔧 Repair connection"}
                    </button>{" "}
                  </>
                )}
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
  );
  if (inline) return panel;
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="th-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Tip ${author}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {panel}
    </div>
  );
}

