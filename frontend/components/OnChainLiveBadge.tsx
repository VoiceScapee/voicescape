"use client";

import { getActiveChain } from "@/lib/chains";

/**
 * Pulsing "live on-chain" badge for public blockpages.
 *
 * Rendered only after /api/resolve has read the page's registration live
 * from the Registry contract — so the badge is an honest signal, not
 * decoration. Links to HashScan so anyone can verify the registration.
 */
export default function OnChainLiveBadge({ owner }: { owner: string }) {
  const chain = getActiveChain();
  const shortOwner =
    owner && owner.length > 10
      ? `${owner.slice(0, 6)}…${owner.slice(-4)}`
      : owner || "unknown";

  return (
    <div className="pv-chain-badge" role="status" aria-label="Page verified live on Hedera">
      <span className="pv-chain-dot" aria-hidden="true" />
      <span className="pv-chain-text">
        <strong>Live on Hedera</strong>
        <span className="pv-chain-sub">
          Registered on-chain · owner <span className="vs-mono">{shortOwner}</span>
        </span>
      </span>
      <a
        className="pv-chain-verify"
        href={`${chain.blockExplorer}/contract/0.0.10854058`}
        target="_blank"
        rel="noreferrer"
      >
        Verify
      </a>
    </div>
  );
}
