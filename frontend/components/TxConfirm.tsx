"use client";

/**
 * Shared reactive transaction UI: the "alive" confirming state and the
 * success receipt with exact finality proof.
 *
 * Used by the tip flows (blockpage + townhall). The confirming state plays
 * a branded sound-wave animation — never a dead spinner — and the receipt
 * proves finality: elapsed seconds from wallet approval to consensus, the
 * exact confirmation time, a precise breakdown of what happened, a
 * prominent VIEW ON HASHSCAN button, and what happens next.
 */
import { IconCheck, IconExternal } from "@/components/icons";
import { formatFinalitySecs, formatFinalizedAt } from "@/lib/tx-confirm";

export function TxConfirming({
  title = "Confirming on Hedera…",
  sub,
}: {
  title?: string;
  sub?: string;
}) {
  return (
    <div className="tx-confirm" role="status" aria-live="polite">
      <div className="tx-eq" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <p className="tx-confirm-title">
        <span className="tx-live-dot" aria-hidden="true" />
        {title}
      </p>
      {sub && <p className="th-muted tx-confirm-sub">{sub}</p>}
    </div>
  );
}

export interface TxReceiptLine {
  label: string;
  value: string;
}

export function TxReceipt({
  title,
  approvedAt,
  finalizedAt,
  txId,
  explorerBase,
  lines,
  nextStep,
  onAgain,
  againLabel = "Tip again",
  onDone,
}: {
  title: string;
  /** ms timestamp of wallet approval (start of the finality clock). */
  approvedAt: number | null;
  /** Date the mirror node reported consensus (end of the finality clock). */
  finalizedAt: Date | null;
  txId: string;
  explorerBase: string;
  lines: TxReceiptLine[];
  nextStep: string;
  onAgain?: () => void;
  againLabel?: string;
  onDone: () => void;
}) {
  const elapsed =
    approvedAt != null && finalizedAt != null
      ? formatFinalitySecs(finalizedAt.getTime() - approvedAt)
      : null;
  return (
    <div className="tx-receipt">
      <div className="tx-receipt-check" aria-hidden="true">
        <IconCheck size={30} />
      </div>
      <h3 className="tx-receipt-title">{title}</h3>
      {elapsed && finalizedAt && (
        <p className="tx-finality">
          Confirmed in {elapsed} · finalized at {formatFinalizedAt(finalizedAt)}
        </p>
      )}
      <div className="tx-rows" aria-label="Transaction breakdown">
        {lines.map((l) => (
          <div className="tx-row" key={l.label}>
            <span>{l.label}</span>
            <span>{l.value}</span>
          </div>
        ))}
      </div>
      <a
        className="vs-btn vs-btn-primary tx-hashscan"
        href={`${explorerBase}/transaction/${txId}`}
        target="_blank"
        rel="noreferrer"
      >
        View on HashScan <IconExternal size={14} />
      </a>
      {nextStep && <p className="tx-next">{nextStep}</p>}
      <div className="tx-actions">
        {onAgain && (
          <button type="button" className="vs-btn vs-btn-ghost" onClick={onAgain}>
            {againLabel}
          </button>
        )}
        <button type="button" className="vs-btn vs-btn-ghost" onClick={onDone}>
          Done
        </button>
      </div>
      <p className="vs-mono tx-txid">{txId}</p>
    </div>
  );
}
