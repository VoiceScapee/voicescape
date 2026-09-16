"use client";

import { IconTip } from "./icons";

/**
 * The post-tip moment. When a tip (or fundraiser donation) confirms
 * on-chain, the sender sees a sound-wave ripple bursting from the
 * megaphone with their tip amount — a little celebration instead of a
 * boring receipt. Pure CSS, no libraries, respects reduced motion.
 *
 * Rendered above the TxReceipt in TipBox's confirmed state, so the
 * proof details (explorer link, share, receipt lines) stay intact below.
 */
export default function TipCelebration({
  usd,
  hbar,
  username,
}: {
  usd: string;
  hbar: string | null;
  username: string;
}) {
  return (
    <div className="pv-tip-celebration" role="status" aria-live="polite">
      <div className="pv-ripple-stage" aria-hidden="true">
        <span className="pv-ripple-ring" style={{ animationDelay: "0s" }} />
        <span className="pv-ripple-ring" style={{ animationDelay: "0.7s" }} />
        <span className="pv-ripple-ring" style={{ animationDelay: "1.4s" }} />
        <span className="pv-ripple-core">
          <IconTip size={30} />
        </span>
      </div>
      <div className="pv-tip-celebration-amount">
        {usd}
        {hbar && <span className="pv-tip-celebration-hbar">≈ {hbar} HBAR</span>}
      </div>
      <p className="pv-tip-celebration-sub">
        Tip confirmed — @{username} just felt that.
      </p>
    </div>
  );
}
