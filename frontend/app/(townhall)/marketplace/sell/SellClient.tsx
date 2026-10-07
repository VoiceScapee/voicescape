"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWriteGate } from "@/components/townhall/useTownhall";
import { useHcsSubmit } from "@/components/townhall/useHcsSubmit";
import { useWallet } from "@/lib/wallet";
import { accountToEvmAddress, makeTownhallId, postJson, usdToHbarDisplay } from "@/lib/townhall";
import { getAuthHeaders } from "@/lib/auth-client";
import { getHbarUsdPrice } from "@/lib/x402";
import { getActiveChain } from "@/lib/chains";
import { resolvePage } from "@/lib/contracts";
import { checkPayoutBelongsToOwner, mirrorBaseFor } from "@/lib/marketplace-verify";

export default function SellClient() {
  const router = useRouter();
  const { account } = useWallet();
  const { username: me, canWrite, isAuthenticated } = useWriteGate();
  const hcs = useHcsSubmit();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [goodsType, setGoodsType] = useState<"physical" | "digital">("physical");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [hbarPrice, setHbarPrice] = useState<number | null>(null);
  // Digital-good file: pinned to IPFS first, CID bound into the listing.
  const [fileCid, setFileCid] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    getHbarUsdPrice().then(setHbarPrice).catch(() => setHbarPrice(null));
  }, []);

  const priceCents = Math.round(Number(price) * 100);
  const valid =
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    Number.isFinite(priceCents) &&
    priceCents > 0 &&
    !uploading;

  const onFile = async (f: File | undefined) => {
    setUploadError(null);
    setFileCid(null);
    if (!f) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", f);
      const res = await fetch("/api/townhall/market/upload", {
        method: "POST",
        headers: { ...getAuthHeaders() },
        body: form,
      });
      const json = (await res.json().catch(() => ({}))) as { cid?: string; error?: string };
      if (!res.ok || !json.cid) {
        setUploadError(json.error ?? "upload failed — try again");
        return;
      }
      setFileCid(json.cid);
    } catch {
      setUploadError("upload failed — check your connection and try again");
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (!valid || !canWrite || !account || !me) return;
    setVerifyError(null);
    // Guardrail: only a verified page owner can list. The connected wallet
    // must own the seller's page on-chain — otherwise the listing would
    // name a payout the seller can't prove ownership of. (The server
    // re-checks this authoritatively; the payout is always the connected
    // wallet — the form accepts no free-text payout address.)
    try {
      const chain = getActiveChain();
      const resolved = await resolvePage(me, chain);
      const ownerOk = resolved?.owner
        ? await checkPayoutBelongsToOwner(
            accountToEvmAddress(account),
            resolved.owner,
            mirrorBaseFor(chain.key),
          )
        : "unknown";
      if (ownerOk !== "match") {
        setVerifyError(
          ownerOk === "mismatch"
            ? `Your wallet does not own the "@${me}" page — sign in with the page owner's wallet to list.`
            : `Could not verify your blockpage ownership on-chain — try again in a moment.`,
        );
        return;
      }
    } catch {
      setVerifyError("Could not verify your blockpage ownership on-chain — try again in a moment.");
      return;
    }
    const t = title.trim();
    const d = description.trim();
    const id = makeTownhallId(t);
    // Submit the listing message via the user's wallet, then notify the
    // server (it verifies the HCS tx via mirror node).
    const hcsTxId = await hcs.submit("market", {
      v: 1,
      kind: "listing",
      ts: new Date().toISOString(),
      author: me,
      id,
      seller: accountToEvmAddress(account),
      sellerUsername: me,
      title: t,
      description: d,
      priceUsdCents: priceCents,
      goodsType,
      ipfsHash: fileCid,
      status: "active",
    });
    if (!hcsTxId) return; // User cancelled or error — phase shows the error
    let newId: string | null = null;
    try {
      const res = await postJson<{ id?: string; listing?: { id?: string } }>(
        "/api/townhall/listings",
        {
          // seller: payout address for direct sales; sellerUsername
          // for the page link / reputation badge.
          seller: accountToEvmAddress(account),
          sellerUsername: me,
          id,
          title: t,
          description: d,
          priceUsdCents: priceCents,
          goodsType,
          ipfsHash: fileCid,
          hcsTxId,
        },
      );
      newId = res.id ?? res.listing?.id ?? null;
    } catch (e) {
      // Server verification failed — the HCS tx is still on-chain, but the
      // server didn't accept it (e.g., content filter). Show the error —
      // the user paid a network fee and must not be left with silence.
      console.error("Listing verification failed:", e);
      const reason = e instanceof Error && e.message ? e.message : "the server rejected it";
      setVerifyError(
        `The listing couldn't be published: ${reason}. Your wallet transaction is on-chain, but the server didn't accept it — no listing was created.`,
      );
      return;
    }
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
          transaction — 98% to you, 2% to the treasury. You sign the listing in
          your wallet — transparent and on-chain.
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
            {(() => {
              const n = Number(price);
              if (!Number.isFinite(n) || n <= 0) return null;
              // Live HBAR equivalent so the seller sees what the buyer will
              // actually be charged before listing.
              return (
                <p className="th-muted" style={{ marginTop: 6 }} data-testid="sell-price-hbar">
                  {usdToHbarDisplay(n, hbarPrice)} charged at checkout
                </p>
              );
            })()}
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
          {goodsType === "digital" && (
            <div>
              <label className="vs-label" htmlFor="sell-file">
                Digital file <span className="th-muted">(optional)</span>
              </label>
              <input
                id="sell-file"
                type="file"
                className="vs-input"
                accept="image/*,.pdf,.zip"
                onChange={(e) => void onFile(e.target.files?.[0])}
                disabled={uploading}
              />
              <p className="th-muted" style={{ marginTop: 6 }}>
                Attach the file buyers receive — image, PDF, or ZIP up to 10 MB.
                It&apos;s pinned to IPFS and released to verified buyers automatically.
                {fileCid && (
                  <>
                    {" "}Attached ✅ <span className="vs-mono" style={{ fontSize: 11 }}>{fileCid.slice(0, 18)}…</span>
                  </>
                )}
                {uploading && "Uploading…"}
              </p>
              {uploadError && (
                <p className="th-error" role="alert" style={{ marginTop: 6 }}>{uploadError}</p>
              )}
            </div>
          )}
          <button
            type="button"
            className="vs-btn vs-btn-primary th-btn-block"
            onClick={submit}
            disabled={!valid || !canWrite || !account || hcs.phase.kind === "submitting"}
          >
            {hcs.phase.kind === "submitting" ? "Sign in wallet…" : `List for $${Number.isFinite(priceCents) && priceCents > 0 ? (priceCents / 100).toFixed(2) : "0.00"}`}
          </button>
          {!account && <p className="th-muted">Connect a wallet — buyers pay out to it.</p>}
          {!canWrite && <p className="th-muted">{isAuthenticated ? "Set your blockpage username (top of the page) — buyers see who you are." : "Sign in with your wallet to list an item."}</p>}
          {hcs.phase.kind === "error" && (
            <p className="th-error" style={{ marginTop: 8 }}>Failed to submit: {hcs.phase.message}</p>
          )}
          {verifyError && (
            <p className="th-error" role="alert" style={{ marginTop: 8 }}>{verifyError}</p>
          )}
        </div>
      </div>
    </>
  );
}
