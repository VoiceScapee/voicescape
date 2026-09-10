"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import DustFeeGate from "@/components/townhall/DustFeeGate";
import { useDustFee, useWriteGate } from "@/components/townhall/useTownhall";
import { useWallet } from "@/lib/wallet";
import { accountToEvmAddress, postJson } from "@/lib/townhall";

export default function SellClient() {
  const router = useRouter();
  const { account } = useWallet();
  const { username: me, canWrite, isAuthenticated } = useWriteGate();
  const dust = useDustFee();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [goodsType, setGoodsType] = useState<"physical" | "digital">("physical");
  const [createdId, setCreatedId] = useState<string | null>(null);

  const priceCents = Math.round(Number(price) * 100);
  const valid =
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    Number.isFinite(priceCents) &&
    priceCents > 0;

  const submit = async () => {
    if (!valid || !canWrite || !account) return;
    let newId: string | null = null;
    const ok = await dust.execute(async (dustFeeTxId) => {
      const res = await postJson<{ id?: string; listing?: { id?: string } }>(
        "/api/townhall/listings",
        {
          // seller: payout address for direct sales; sellerUsername
          // for the page link / reputation badge.
          seller: accountToEvmAddress(account),
          sellerUsername: me,
          title: title.trim(),
          description: description.trim(),
          priceUsdCents: priceCents,
          goodsType,
          dustFeeTxId,
        },
      );
      newId = res.id ?? res.listing?.id ?? null;
    });
    if (!ok) return;
    if (newId) setCreatedId(newId);
    else router.push("/marketplace"); // server returned no id — back to the grid
  };

  if (createdId) {
    return (
      <div className="th-card" style={{ textAlign: "center" }}>
        <h2>Listing live ✅</h2>
        <p className="th-muted">Buyers pay you directly — 98% lands in your wallet the moment they buy.</p>
        <Link href={`/marketplace/${encodeURIComponent(createdId)}`} className="vs-btn vs-btn-primary th-btn-sm">
          View listing →
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="th-page-head">
        <h1>🏷️ Sell <span className="vs-gradient-text">something</span></h1>
        <p>
          List physical or digital goods. Buyers pay you directly in one atomic
          transaction — 98% to you, 2% to the treasury. Listing costs the dust fee.
        </p>
      </div>

      <div className="th-card">
        <div className="th-form">
          <div>
            <label className="vs-label" htmlFor="sell-title">Title</label>
            <input
              id="sell-title"
              className="vs-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What are you selling?"
              maxLength={120}
            />
          </div>
          <div>
            <label className="vs-label" htmlFor="sell-desc">Description</label>
            <textarea
              id="sell-desc"
              className="vs-input th-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Condition, what's included, delivery details…"
              rows={4}
            />
          </div>
          <div>
            <label className="vs-label" htmlFor="sell-price">Price (USD)</label>
            <input
              id="sell-price"
              className="vs-input"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="25.00"
            />
          </div>
          <div>
            <span className="vs-label">Goods type</span>
            <div className="th-segment" role="group" aria-label="Goods type">
              <button
                type="button"
                className={goodsType === "physical" ? "is-active" : ""}
                onClick={() => setGoodsType("physical")}
              >
                📦 Physical
              </button>
              <button
                type="button"
                className={goodsType === "digital" ? "is-active" : ""}
                onClick={() => setGoodsType("digital")}
              >
                ⬇ Digital
              </button>
            </div>
          </div>
          <button
            type="button"
            className="vs-btn vs-btn-primary th-btn-block"
            onClick={submit}
            disabled={!valid || !canWrite || !account || dust.phase.kind === "working" || dust.phase.kind === "paying"}
          >
            {dust.phase.kind === "working" || dust.phase.kind === "paying" ? "Listing…" : `List for $${Number.isFinite(priceCents) && priceCents > 0 ? (priceCents / 100).toFixed(2) : "0.00"}`}
          </button>
          {!account && <p className="th-muted">Connect a wallet — buyers pay out to it.</p>}
          {!canWrite && <p className="th-muted">{isAuthenticated ? "Set your page username (top of the page) — buyers see who you are." : "Sign in with your wallet to list an item."}</p>}
          <DustFeeGate flow={dust} actionLabel="listing" />
        </div>
      </div>
    </>
  );
}
