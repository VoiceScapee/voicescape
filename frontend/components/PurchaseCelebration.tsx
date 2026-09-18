"use client";

/**
 * The post-purchase moment. When a marketplace purchase confirms on-chain,
 * the buyer gets a celebration instead of a flat receipt — the same
 * celebratory beat the tip flow gets from TipCelebration.
 *
 * Two variants:
 * - Badge listings (badge prop): the earned badge pops into a medallion —
 *   "Badge earned!" — because buying a badge should *feel* like earning one.
 * - Everything else: a check burst — "It's yours!"
 *
 * Shared across the whole dapp: any surface that completes a purchase
 * (town hall marketplace today, blockpage stores tomorrow) renders this
 * above the TxReceipt, so the proof details (explorer link, receipt lines)
 * stay intact below. Pure CSS, no libraries, respects reduced motion.
 */
export default function PurchaseCelebration({
  badge,
  title,
}: {
  /** Set for listings that award a badge (icon + name from the badge catalog). */
  badge?: { icon: string; name: string } | null;
  /** Listing title, shown in the generic variant. */
  title: string;
}) {
  if (badge) {
    return (
      <div className="pv-buy-celebration" role="status" aria-live="polite">
        <div className="pv-buy-medallion" aria-hidden="true">
          <span className="pv-buy-ring" style={{ animationDelay: "0s" }} />
          <span className="pv-buy-ring" style={{ animationDelay: "0.7s" }} />
          <span className="pv-buy-ring" style={{ animationDelay: "1.4s" }} />
          <span className="pv-buy-medallion-core">{badge.icon}</span>
        </div>
        <div className="pv-buy-celebration-title">Badge earned!</div>
        <p className="pv-buy-celebration-sub">
          The {badge.name} is now on your blockpage.
        </p>
      </div>
    );
  }
  return (
    <div className="pv-buy-celebration" role="status" aria-live="polite">
      <div className="pv-buy-medallion is-generic" aria-hidden="true">
        <span className="pv-buy-ring" style={{ animationDelay: "0s" }} />
        <span className="pv-buy-ring" style={{ animationDelay: "0.7s" }} />
        <span className="pv-buy-medallion-core pv-buy-check">✓</span>
      </div>
      <div className="pv-buy-celebration-title">It&apos;s yours!</div>
      <p className="pv-buy-celebration-sub">
        {title} — payment confirmed on-chain.
      </p>
    </div>
  );
}
