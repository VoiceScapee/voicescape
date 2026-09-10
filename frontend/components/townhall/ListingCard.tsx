"use client";

/**
 * Shared marketplace bits: listing card, price formatting, seller line.
 */
import Link from "next/link";
import ReputationBadge, { VoteControls } from "./Reputation";
import { parseSeller, type Listing } from "@/lib/townhall";

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function shortAddr(addr: string): string {
  if (/^\d+\.\d+\.\d+$/.test(addr)) return addr;
  return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export function SellerLine({ listing }: { listing: Listing }) {
  const { address, username } = parseSeller(listing);
  return (
    <span className="th-row" style={{ gap: 8 }}>
      {username ? (
        <>
          <Link href={`/${username}`} className="th-post-author">
            @{username}
          </Link>
          <ReputationBadge username={username} compact />
        </>
      ) : address ? (
        <span className="vs-mono th-muted" title={address}>
          {shortAddr(address)}
        </span>
      ) : (
        <span className="th-muted">unknown seller</span>
      )}
    </span>
  );
}

export function ListingCard({ listing }: { listing: Listing }) {
  const sold = listing.status === "sold";
  return (
    <Link href={`/marketplace/${encodeURIComponent(listing.id)}`} className="th-card th-card-link">
      <div className="th-between">
        <span className={`th-badge is-${listing.goodsType}`}>
          {listing.goodsType === "digital" ? "⬇ digital" : "📦 physical"}
        </span>
        {sold && <span className="th-badge is-sold">sold</span>}
      </div>
      <h3 style={{ marginTop: 10 }}>{listing.title}</h3>
      <div className="th-price">{formatUsd(listing.priceUsdCents)}</div>
      <p style={{ marginTop: 8 }}>{listing.description.slice(0, 120)}{listing.description.length > 120 ? "…" : ""}</p>
      <SellerLine listing={listing} />
    </Link>
  );
}

/** Review note shown on listing detail — proof-of-payment is enforced server-side. */
export function ReviewNote({ listing }: { listing: Listing }) {
  const { username } = parseSeller(listing);
  return (
    <div className="th-note">
      <strong>Reviews you can trust:</strong> only verified buyers — wallets with a completed
      on-chain purchase from this seller — can vote. Eligibility is checked against the
      Tips contract on-chain.{" "}
      {username ? (
        <>
          See <Link href={`/${username}`} className="th-identity-link">@{username}&apos;s page</Link> for
          their reviews. <VoteControls target={username} />
        </>
      ) : (
        "See the seller's page for their reviews."
      )}
    </div>
  );
}
