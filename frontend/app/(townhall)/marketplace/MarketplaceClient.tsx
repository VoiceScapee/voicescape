"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ListingCard } from "@/components/townhall/ListingCard";
import { PresenceDot } from "@/components/townhall/Presence";
import { useStreamEvents } from "@/components/townhall/useStream";
import { getJson, type Listing } from "@/lib/townhall";

function isListingView(m: unknown): m is Listing {
  return (
    !!m &&
    typeof m === "object" &&
    typeof (m as Listing).id === "string" &&
    typeof (m as Listing).title === "string"
  );
}

export default function MarketplaceClient() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "physical" | "digital">("all");

  useEffect(() => {
    getJson<{ listings?: Listing[] }>("/api/townhall/listings")
      .then((d) => setListings(Array.isArray(d.listings) ? d.listings : []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Live: upsert by id (status updates are new messages with the same id);
  // brand-new listings go on top, updates keep their position.
  const mergeListings = useCallback((incoming: Listing[]) => {
    if (incoming.length === 0) return;
    setListings((prev) => {
      const seen = new Set(prev.map((l) => l.id));
      const fresh = incoming.filter((l) => !seen.has(l.id));
      if (fresh.length === 0 && !incoming.some((l) => seen.has(l.id))) return prev;
      const updates = new Map(incoming.map((l) => [l.id, l]));
      const merged = prev.map((l) => updates.get(l.id) ?? l);
      return [...fresh, ...merged];
    });
  }, []);

  useStreamEvents<Listing>("/api/townhall/listings/stream", mergeListings, isListingView, { dataKey: "listings" });

  const shown = listings.filter(
    (l) => filter === "all" || l.goodsType === filter,
  );
  const active = shown.filter((l) => l.status !== "sold" && l.status !== "cancelled");

  return (
    <>
      <div className="th-page-head">
        <div className="th-between">
          <h1>🛒 <span className="vs-gradient-text">Marketplace</span></h1>
          <Link href="/marketplace/sell" className="vs-btn vs-btn-primary th-btn-sm">
            + Sell
          </Link>
        </div>
        <p>
          Direct sales, settled on-chain: one transaction pays the seller 98%
          and the treasury 2% — nothing is ever held in escrow. Prices in USD,
          settled in HBAR. Delivery is arranged with the seller; check their
          reputation first. <PresenceDot scope="marketplace" />
        </p>
      </div>

      <div className="th-row" style={{ marginBottom: 16 }}>
        <Link href="/marketplace/purchases" className="vs-btn vs-btn-ghost th-btn-sm">
          My purchases →
        </Link>
        <div className="th-segment" style={{ marginLeft: "auto" }} role="group" aria-label="Filter listings">
          {(["all", "physical", "digital"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={filter === f ? "is-active" : ""}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : f === "physical" ? "📦 Physical" : "⬇ Digital"}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="th-muted">Loading listings…</p>}
      {error && <p className="th-error">Couldn&apos;t load listings: {error}</p>}
      {!loading && !error && active.length === 0 && (
        <p className="th-muted">
          Nothing for sale yet. <Link href="/marketplace/sell" className="th-identity-link">List something →</Link>
        </p>
      )}
      <div className="th-grid">
        {active.map((l) => (
          <ListingCard key={l.id} listing={l} />
        ))}
      </div>
    </>
  );
}
