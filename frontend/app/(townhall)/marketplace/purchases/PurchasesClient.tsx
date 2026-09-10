"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  getPurchases,
  removePurchase,
  timeAgo,
  type Purchase,
} from "@/lib/townhall";

function PurchaseCard({
  purchase,
  onRemove,
}: {
  purchase: Purchase;
  onRemove: () => void;
}) {
  return (
    <div className="th-card">
      <div className="th-between">
        <h3>
          {purchase.listingId ? (
            <Link
              href={`/marketplace/${encodeURIComponent(purchase.listingId)}`}
              className="th-identity-link"
            >
              {purchase.note || purchase.listingId}
            </Link>
          ) : (
            purchase.note || "Purchase"
          )}
        </h3>
        <span className="th-badge is-sold">paid</span>
      </div>
      <p className="th-muted">
        {purchase.amountHbar} · {timeAgo(purchase.boughtAt)}
      </p>
      <p className="th-muted vs-mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
        tx {purchase.tx}
      </p>
      <p className="th-muted" style={{ fontSize: 12 }}>
        Seller paid directly — 98% to the seller, 2% to the treasury, in one
        transaction. No funds were held in escrow.
      </p>
      <div className="th-row" style={{ marginTop: 8 }}>
        <button type="button" className="th-identity-link" onClick={onRemove}>
          remove
        </button>
      </div>
    </div>
  );
}

export default function PurchasesClient() {
  const [purchases, setPurchases] = useState<Purchase[]>([]);

  const load = () => setPurchases(getPurchases());

  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <div className="th-page-head">
        <h1>🧾 My <span className="vs-gradient-text">purchases</span></h1>
        <p>
          Completed marketplace purchases from this device. Each was a single
          atomic transaction — the seller was paid directly, nothing was held.
        </p>
      </div>

      {purchases.length === 0 && (
        <p className="th-muted">
          No purchases yet. <Link href="/marketplace" className="th-identity-link">Browse the marketplace →</Link>
        </p>
      )}
      {purchases.map((p) => (
        <PurchaseCard
          key={`${p.tx}-${p.listingId}`}
          purchase={p}
          onRemove={() => {
            removePurchase(p.tx, p.listingId);
            load();
          }}
        />
      ))}
    </>
  );
}
