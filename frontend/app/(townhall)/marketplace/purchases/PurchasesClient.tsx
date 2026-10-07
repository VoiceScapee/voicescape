"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  getPurchases,
  getJson,
  removePurchase,
  timeAgo,
  type Purchase,
} from "@/lib/townhall";
import { useSession } from "@/lib/session";

/** A purchase verified on-chain (cross-device source of truth). */
interface ChainPurchase {
  listingRef: string;
  title: string;
  tx: string;
  timestamp: string;
  goodsType: string | null;
  ipfsHash: string | null;
  sellerUsername: string | null;
}

function DownloadButton({ listingRef, wallet }: { listingRef: string; wallet: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await getJson<{ url?: string; error?: string }>(
        `/api/townhall/market/delivery?listingId=${encodeURIComponent(listingRef)}&wallet=${encodeURIComponent(wallet)}`,
      );
      if (data.url) setUrl(data.url);
      else setError(data.error ?? "download unavailable");
    } catch {
      setError("couldn't verify your purchase — try again");
    } finally {
      setBusy(false);
    }
  };

  if (url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="vs-btn vs-btn-primary th-btn-sm">
        ⬇ Download your file
      </a>
    );
  }
  return (
    <>
      <button type="button" className="vs-btn vs-btn-primary th-btn-sm" onClick={reveal} disabled={busy}>
        {busy ? "Verifying purchase…" : "⬇ Get your file"}
      </button>
      {error && (
        <p className="th-error" style={{ marginTop: 6, fontSize: 12 }}>{error}</p>
      )}
    </>
  );
}

function PurchaseCard({
  purchase,
  onRemove,
  wallet,
  chain,
}: {
  purchase: Purchase;
  onRemove: () => void;
  wallet?: string;
  chain?: ChainPurchase | null;
}) {
  const downloadable = chain?.goodsType === "digital" && chain.ipfsHash && wallet;
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
        {downloadable && <DownloadButton listingRef={chain!.listingRef} wallet={wallet!} />}
        <button type="button" className="th-identity-link" onClick={onRemove}>
          remove
        </button>
      </div>
    </div>
  );
}

function toLocalPurchase(c: ChainPurchase): Purchase {
  return {
    listingId: c.listingRef,
    note: c.title,
    tx: c.tx,
    amountHbar: "",
    seller: "",
    boughtAt: c.timestamp ? Math.floor(Number(c.timestamp.split(".")[0]) * 1000) : Date.now(),
  };
}

export default function PurchasesClient() {
  const { session } = useSession();
  const wallet = session?.address ?? undefined;
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [chainPurchases, setChainPurchases] = useState<ChainPurchase[] | null>(null);
  const [chainFailed, setChainFailed] = useState(false);

  const loadLocal = () => setPurchases(getPurchases());

  useEffect(() => {
    loadLocal();
  }, []);

  useEffect(() => {
    if (!wallet) {
      setChainPurchases(null);
      return;
    }
    let live = true;
    setChainFailed(false);
    getJson<{ purchases?: ChainPurchase[] }>(
      `/api/townhall/market/purchases?wallet=${encodeURIComponent(wallet)}`,
    )
      .then((d) => {
        if (live) setChainPurchases(Array.isArray(d.purchases) ? d.purchases : []);
      })
      .catch(() => {
        if (live) {
          setChainPurchases(null);
          setChainFailed(true);
        }
      });
    return () => {
      live = false;
    };
  }, [wallet]);

  // Chain truth wins when available; localStorage is the offline fallback.
  const useChain = chainPurchases !== null;
  const list: Purchase[] = useChain ? chainPurchases!.map(toLocalPurchase) : purchases;
  const chainByRef = new Map((chainPurchases ?? []).map((c) => [c.listingRef, c]));

  return (
    <>
      <div className="th-page-head">
        <h1>🧾 My <span className="vs-gradient-text">purchases</span></h1>
        <p>
          {useChain
            ? "Verified on-chain purchases for your wallet — the same on every device. Each was a single atomic transaction — the seller was paid directly, nothing was held."
            : "Completed marketplace purchases from this device. Each was a single atomic transaction — the seller was paid directly, nothing was held."}
        </p>
        {chainFailed && (
          <p className="th-muted" style={{ fontSize: 12 }}>
            On-chain lookup unavailable — showing this device&apos;s saved receipts.
          </p>
        )}
      </div>

      {list.length === 0 && (
        <p className="th-muted">
          No purchases yet. <Link href="/marketplace" className="th-identity-link">Browse the marketplace →</Link>
        </p>
      )}
      {list.map((p) => (
        <PurchaseCard
          key={`${p.tx}-${p.listingId}`}
          purchase={p}
          wallet={wallet}
          chain={chainByRef.get(p.listingId) ?? null}
          onRemove={() => {
            removePurchase(p.tx, p.listingId);
            loadLocal();
          }}
        />
      ))}
    </>
  );
}
