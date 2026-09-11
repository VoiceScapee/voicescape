"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ReviewNote, SellerLine, formatUsd } from "@/components/townhall/ListingCard";
import { useWallet } from "@/lib/wallet";
import { useSession } from "@/lib/session";
import { useWriteGate } from "@/components/townhall/useTownhall";
import { buyListing } from "@/lib/contracts";
import { getHbarUsdPrice } from "@/lib/x402";
import { usdToWei } from "@/lib/tokens";
import {
  accountToEvmAddress,
  getJson,
  parseSeller,
  postJson,
  recordPurchase,
  timeAgo,
  usdToHbarDisplay,
  type Listing,
} from "@/lib/townhall";

type BuyPhase =
  | { kind: "idle" }
  | { kind: "buying" }
  | { kind: "done"; tx: string }
  | { kind: "error"; message: string };

/** Normalize a listing payout address to a 0x EVM address for the contract call. */
function sellerToEvm(addr: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(addr)) return addr;
  return accountToEvmAddress(addr);
}

export default function ListingDetailClient({ id }: { id: string }) {
  const { account, getTxSender } = useWallet();
  const { username: me, canWrite } = useWriteGate();
  let viewerAddress: string | undefined;
  try {
    viewerAddress = useSession().session?.address ?? undefined;
  } catch {
    viewerAddress = undefined;
  }
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hbarPrice, setHbarPrice] = useState<number | null>(null);
  const [buy, setBuy] = useState<BuyPhase>({ kind: "idle" });
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  /** Seller-only: mark sold / cancelled. The server verifies the signed session owns the seller page. */
  const changeStatus = async (status: "sold" | "cancelled") => {
    if (!listing || !me || !canWrite) return;
    setStatusBusy(true);
    setStatusError(null);
    try {
      await postJson(`/api/townhall/listings/${encodeURIComponent(listing.id)}/status`, {
        sellerUsername: me,
        status,
      });
      load();
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatusBusy(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // No single-listing endpoint in the contract — find it in the list.
      const data = await getJson<{ listings?: Listing[] }>("/api/townhall/listings");
      const found = (Array.isArray(data.listings) ? data.listings : []).find((l) => l.id === id);
      if (!found) throw new Error("Listing not found.");
      setListing(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    load();
    getHbarUsdPrice().then(setHbarPrice).catch(() => setHbarPrice(null));
  }, [load]);

  // Fire-and-forget listing view for creator analytics (counts toward the
  // seller's stats; the server skips the seller's own views).
  useEffect(() => {
    if (!listing?.sellerUsername || !listing?.id) return;
    fetch("/api/analytics/view", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: listing.sellerUsername,
        subject: `listing:${listing.id}`,
        label: listing.title,
        viewerAddress,
      }),
      keepalive: true,
    }).catch(() => {
      /* analytics must never break the page */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.id]);

  const usd = listing ? listing.priceUsdCents / 100 : 0;
  const { address: sellerAddress } = parseSeller(listing ?? ({} as Listing));
  const sold = listing?.status === "sold" || listing?.status === "cancelled";

  const startBuy = async () => {
    setBuy({ kind: "buying" });
    try {
      if (!account) throw new Error("Connect a wallet to buy.");
      if (!listing) throw new Error("Listing not loaded.");
      if (!sellerAddress) throw new Error("This listing has no seller payout address.");
      if (!hbarPrice) throw new Error("HBAR price is still loading — try again in a moment.");
      const wei = usdToWei(usd, hbarPrice);
      const sender = await getTxSender();
      // One atomic transaction: 98% to the seller, 2% to the treasury.
      // The contract never holds your funds — there is no escrow.
      const tx = await buyListing(sellerToEvm(sellerAddress), listing.id, wei, sender);
      recordPurchase({
        listingId: listing.id,
        note: listing.title,
        tx,
        amountHbar: usdToHbarDisplay(usd, hbarPrice),
        seller: sellerAddress,
      });
      setBuy({ kind: "done", tx });
    } catch (e) {
      setBuy({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const buyerEvm = account ? accountToEvmAddress(account).toLowerCase() : null;
  const isOwnListing =
    !!buyerEvm && !!sellerAddress && buyerEvm === sellerToEvm(sellerAddress).toLowerCase();

  return (
    <>
      <div className="th-page-head">
        <p>
          <Link href="/marketplace" className="th-identity-link">← marketplace</Link>
        </p>
      </div>

      {loading && <p className="th-muted">Loading listing…</p>}
      {error && <p className="th-error">{error}</p>}

      {listing && (
        <div className="th-card">
          <div className="th-between">
            <span className={`th-badge is-${listing.goodsType}`}>
              {listing.goodsType === "digital" ? "⬇ digital" : "📦 physical"}
            </span>
            {sold && <span className="th-badge is-sold">{listing.status}</span>}
          </div>
          <h1 style={{ fontSize: "1.5rem", margin: "12px 0 4px" }}>{listing.title}</h1>
          <div className="th-price">{formatUsd(listing.priceUsdCents)}</div>
          <div className="th-price-sub">{usdToHbarDisplay(usd, hbarPrice)} · settled in HBAR</div>
          <p style={{ whiteSpace: "pre-wrap", marginTop: 14, color: "var(--vs-text)" }}>
            {listing.description}
          </p>
          <div className="th-row" style={{ margin: "12px 0" }}>
            <span className="th-muted">Seller:</span> <SellerLine listing={listing} />
          </div>
          {listing.ts ? <p className="th-muted">Listed {timeAgo(listing.ts)}</p> : null}

          <div className="th-section" style={{ margin: "18px 0" }}>
            <ReviewNote listing={listing} />
          </div>

          {!sold && !isOwnListing && buy.kind === "idle" && (
            <button type="button" className="vs-btn vs-btn-primary th-btn-block" onClick={startBuy}>
              Buy now — {formatUsd(listing.priceUsdCents)}
            </button>
          )}
          {isOwnListing && !sold && (
            <p className="th-note">This is your listing. Buyers pay you directly — 98% lands in your payout address the moment they buy.</p>
          )}
          {me && listing.sellerUsername && me.toLowerCase() === listing.sellerUsername.toLowerCase() && !sold && (
            <div className="th-section" style={{ margin: "18px 0" }}>
              <p className="th-muted" style={{ marginBottom: 8 }}>Seller actions</p>
              <div className="th-row">
                <button
                  type="button"
                  className="vs-btn vs-btn-primary th-btn-sm"
                  onClick={() => changeStatus("sold")}
                  disabled={statusBusy || !canWrite}
                >
                  {statusBusy ? "Updating…" : "Mark as sold"}
                </button>
                <button
                  type="button"
                  className="vs-btn vs-btn-ghost th-btn-sm"
                  onClick={() => changeStatus("cancelled")}
                  disabled={statusBusy || !canWrite}
                >
                  {statusBusy ? "Updating…" : "Cancel listing"}
                </button>
              </div>
              {!canWrite && (
                <p className="th-muted" style={{ marginTop: 8 }}>
                  Sign in with your wallet and set your page username to manage this listing.
                </p>
              )}
              {statusError && <p className="th-error" style={{ marginTop: 8 }}>{statusError}</p>}
            </div>
          )}

          {buy.kind === "buying" && (
            <p className="th-muted" role="status">Sending the payment — approve in your wallet…</p>
          )}

          {buy.kind === "done" && (
            <div className="th-dust" role="status">
              <div className="th-dust-title">Purchase complete ✅</div>
              <p>
                Paid in one transaction (tx <span className="vs-mono">{buy.tx.slice(0, 24)}…</span>) —
                98% went straight to the seller, 2% to the Voicescape treasury. Nothing was
                held in escrow. Arrange delivery with the seller directly.
              </p>
              <Link href="/marketplace/purchases" className="vs-btn vs-btn-primary th-btn-sm">
                View my purchases →
              </Link>
            </div>
          )}

          {buy.kind === "error" && (
            <div className="th-dust is-error" role="alert">
              <div className="th-dust-title">Purchase failed</div>
              <p>{buy.message}</p>
              <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={() => setBuy({ kind: "idle" })}>
                Try again
              </button>
            </div>
          )}

          <div className="th-note" style={{ marginTop: 16 }}>
            <strong>Direct sale, no escrow:</strong> your payment goes straight to the
            seller in a single transaction — the platform never holds your funds.
            That means no buyer protection: check the seller&apos;s reputation
            (reviews only come from wallets with a completed on-chain purchase)
            and agree on delivery before you buy.
          </div>
        </div>
      )}
    </>
  );
}
