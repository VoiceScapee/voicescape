"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ListingCard } from "@/components/townhall/ListingCard";
import { getJson, type Listing } from "@/lib/townhall";

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
          reputation first.
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
