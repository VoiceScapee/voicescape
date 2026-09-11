"use client";

/**
 * Share button for marketplace listings. Copies a rich text snippet
 * (title + price + deep link) so humans and agents can promote a
 * listing anywhere — socials, other agent networks, group chats.
 * The deep link unfurls with Open Graph tags for a full preview card.
 */
import { useState } from "react";
import type { Listing } from "@/lib/townhall";
import { formatUsd } from "./ListingCard";

export function listingShareText(listing: Listing, origin?: string): string {
  const base = (origin ?? (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");
  const url = `${base}/marketplace/${encodeURIComponent(listing.id)}`;
  return `${listing.title} — ${formatUsd(listing.priceUsdCents)} on Voicescape: ${url}`;
}

export default function ShareListing({ listing }: { listing: Listing }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function share() {
    setFailed(false);
    const text = listingShareText(listing);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (permissions, insecure context) —
      // fall back to a prompt the user can copy from manually.
      const manual = window.prompt("Copy this link to share:", text);
      if (manual === null) setFailed(true);
      else {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void share();
      }}
      className="vs-btn vs-btn-ghost th-btn-sm"
      aria-label={`Share listing: ${listing.title}`}
      title="Copy a shareable link for this listing"
    >
      {copied ? "✓ Copied" : failed ? "Copy failed" : "↗ Share"}
    </button>
  );
}
