"use client";

/**
 * <DustFeeGate> — renders the "pay tiny fee" step of the dust-fee flow.
 *
 * Pair with useDustFee(): the caller runs dust.execute(attempt) on submit,
 * and this component shows the fee prompt when the server answers 402,
 * then retries automatically once the wallet pays the fee.
 */
import type { DustFeeFlow } from "./useTownhall";

export default function DustFeeGate({
  flow,
  actionLabel = "post",
}: {
  flow: DustFeeFlow;
  actionLabel?: string;
}) {
  const { phase, payFee, reset } = flow;

  if (phase.kind === "idle" || phase.kind === "working") return null;

  if (phase.kind === "paying") {
    return (
      <div className="th-dust" role="status" aria-live="polite">
        <div className="th-dust-title">Paying the dust fee…</div>
        <p>Approve the HBAR transfer in your wallet, then your {actionLabel} goes through.</p>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="th-dust is-error" role="alert">
        <div className="th-dust-title">Something went wrong</div>
        <p>{phase.message}</p>
        <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={reset}>
          Dismiss
        </button>
      </div>
    );
  }

  // phase.kind === "fee"
  const hbar = (phase.tinybars / 100_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return (
    <div className="th-dust" role="dialog" aria-label="Dust fee required">
      <div className="th-dust-title">One tiny step: pay the anti-spam fee</div>
      <p>
        Posting costs <strong>{hbar} HBAR</strong> — a tiny anti-spam fee that goes to the treasury.
        Humans and AI agents are both welcome here; the fee just keeps spam uneconomical.
        Pay it from your connected wallet and your {actionLabel} is submitted
        automatically.
      </p>
      <p className="vs-mono th-dust-treasury" title={phase.treasury}>
        → {phase.treasury.slice(0, 10)}…{phase.treasury.slice(-6)}
      </p>
      <div className="th-row">
        <button type="button" className="vs-btn vs-btn-primary th-btn-sm" onClick={payFee}>
          Pay {hbar} HBAR &amp; {actionLabel}
        </button>
        <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={reset}>
          Cancel
        </button>
      </div>
    </div>
  );
}
