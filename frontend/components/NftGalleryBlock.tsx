"use client";

/**
 * NFT Gallery block — the buyer's window into a creator's HTS NFT drop.
 *
 * Reads LIVE mirror-node data (via /api/nfts): token info + minted
 * serials, artwork resolved through each NFT's wallet-readable (HIP-412)
 * metadata JSON — the same document HashPack's NFT gallery reads, so
 * anything rendered here renders in the buyer's wallet too. Every NFT
 * links its HashScan page for independent verification.
 *
 * Buyer journey (numbered, explicit — association is never hidden):
 *   1. ASSOCIATE — Hedera requires your account to associate the token
 *      before it can receive the NFT. One tap: you sign in your own
 *      wallet, you pay the tiny fee. Wired through the existing
 *      submitPreparedTx pipeline (untouched); the dapp never holds keys.
 *   2. BUY — through the creator's marketplace listing: one atomic
 *      payment splits 98% to the seller, 2% to the treasury. No escrow —
 *      trust comes from the public on-chain purchase record.
 *   3. RECEIVE — the seller transfers the NFT serial to your account
 *      after payment verifies (peer-to-peer, from their own wallet).
 *   4. VIEW — it lands in your HashPack NFT gallery as a real HTS NFT.
 *
 * True ownership is the selling point, stated plainly: you can hold it,
 * view it in HashPack, send it peer-to-peer to anyone — we neither can
 * nor want to restrict that — or relist it. A relist pays the lister
 * (you) 98% through the same atomic split.
 */
import { useCallback, useEffect, useState } from "react";
import type { Block } from "@/lib/schema";
import { getHederaPairing } from "@/lib/wallet";
import {
  submitPreparedTx,
  NoWalletPairingError,
  type PreparedTxPayload,
} from "@/lib/prepared-tx";
import { IconCheck, IconExternal, IconGrid, IconWallet } from "./icons";

type NftGalleryBlockT = Extract<Block, { type: "nftGallery" }>;

interface GalleryNft {
  serial: number;
  name: string | null;
  imageUrl: string | null;
  hashscanUrl: string;
}

interface GalleryData {
  tokenId: string;
  name: string;
  symbol: string;
  totalSupply: string | null;
  hashscanUrl: string;
  nfts: GalleryNft[];
}

type AssocState = "idle" | "working" | "done" | "error";

export default function NftGalleryBlock({ block }: { block: NftGalleryBlockT }) {
  const tokenId = (block.token_id ?? "").trim();
  const title = block.title?.trim() || "NFT Gallery";
  const [data, setData] = useState<GalleryData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [assoc, setAssoc] = useState<AssocState>("idle");
  const [assocMsg, setAssocMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!tokenId) return;
    let cancelled = false;
    setLoadError(null);
    setData(null);
    fetch(`/api/nfts?tokenId=${encodeURIComponent(tokenId)}`, { cache: "no-store" })
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as
          | GalleryData
          | { error?: string }
          | null;
        if (cancelled) return;
        // Optional "error" prop defeats `in`-narrowing, so discriminate
        // on the value, not the key.
        const errMsg =
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : null;
        if (!r.ok || !body || errMsg) {
          setLoadError(errMsg || "Couldn't load this collection — check your connection and retry.");
          return;
        }
        setData(body as GalleryData);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Couldn't load this collection — check your connection and retry.");
      });
    return () => {
      cancelled = true;
    };
  }, [tokenId]);

  const associate = useCallback(async () => {
    setAssoc("working");
    setAssocMsg(null);
    try {
      const pairing = getHederaPairing();
      if (!pairing) {
        setAssoc("error");
        setAssocMsg("Connect your wallet first, then tap Associate again.");
        return;
      }
      const accountId = pairing.accountId;
      const res = await fetch("/api/nfts/associate-prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId, token_id: tokenId }),
      });
      const body = (await res.json().catch(() => null)) as
        | { prepared?: boolean; alreadyAssociated?: boolean; unsignedTxBytes?: string; transactionId?: string; error?: string }
        | null;
      if (!res.ok || !body || body.error) {
        setAssoc("error");
        setAssocMsg(typeof body?.error === "string" && body.error ? body.error : "Couldn't prepare the association — try again.");
        return;
      }
      if (body.alreadyAssociated) {
        setAssoc("done");
        setAssocMsg("Already associated — your account can receive this collection's NFTs.");
        return;
      }
      const payload: PreparedTxPayload = {
        transactionList: body.unsignedTxBytes as string,
        signerAccountId: `hedera:mainnet:${accountId}`,
        transactionId: body.transactionId as string,
      };
      await submitPreparedTx(payload);
      setAssoc("done");
      setAssocMsg("Associated — your account can now receive NFTs from this collection.");
    } catch (e) {
      setAssoc("error");
      if (e instanceof NoWalletPairingError) {
        setAssocMsg("Connect your wallet first, then tap Associate again.");
      } else if (e instanceof Error && /dismiss|reject|cancel/i.test(e.message)) {
        setAssocMsg("Signature dismissed in your wallet — nothing changed. Tap Associate to try again.");
      } else {
        setAssocMsg("Association didn't complete — try again in a moment.");
      }
    }
  }, [tokenId]);

  if (!tokenId) {
    return (
      <section className="pv-block" aria-label={title}>
        <h2 className="pv-block-title">
          <IconGrid size={20} />
          <span>{title}</span>
        </h2>
        <p className="pv-empty">The owner hasn&apos;t linked an NFT collection yet.</p>
      </section>
    );
  }

  return (
    <section className="pv-block" aria-label={title}>
      <h2 className="pv-block-title">
        <IconGrid size={20} />
        <span>{title}</span>
      </h2>

      {loadError ? (
        <p className="pv-empty">{loadError}</p>
      ) : !data ? (
        <p className="pv-empty">Loading the collection from Hedera…</p>
      ) : (
        <>
          <div className="pv-nft-meta">
            <div>
              <strong>
                {data.name} ({data.symbol})
              </strong>{" "}
              <span className="pv-muted">
                · {data.totalSupply ?? "0"} minted · {data.tokenId}
              </span>
            </div>
            <a href={data.hashscanUrl} target="_blank" rel="noreferrer" className="pv-link">
              View on HashScan <IconExternal size={14} />
            </a>
          </div>

          {/* Buyer journey — association is step 1, never hidden. */}
          <ol className="pv-nft-steps">
            <li>
              <strong>Step 1 — Associate the token.</strong> Hedera requires
              your account to associate this collection before it can receive
              the NFT. One tap below: you sign in your own wallet and you pay
              the tiny network fee — the dapp never touches your keys.
              <div className="pv-nft-assoc">
                <button
                  type="button"
                  className="pv-btn"
                  onClick={associate}
                  disabled={assoc === "working" || assoc === "done"}
                >
                  <IconWallet size={16} />
                  {assoc === "done" ? "Associated" : assoc === "working" ? "Check your wallet…" : "Associate"}
                </button>
                {assoc === "done" && <IconCheck size={16} aria-label="done" />}
              </div>
              {assocMsg && <p className="pv-muted">{assocMsg}</p>}
            </li>
            <li>
              <strong>Step 2 — Buy the listing.</strong> Find this drop in the{" "}
              <a href="/marketplace" className="pv-link">
                marketplace
              </a>{" "}
              and check out: one atomic payment splits 98% to the seller and
              2% to the Voicescape treasury. No escrow — no buyer protection
              beyond the public on-chain purchase record.
            </li>
            <li>
              <strong>Step 3 — Receive the NFT.</strong> The seller transfers
              the NFT serial to your account after payment verifies,
              peer-to-peer from their own wallet.
            </li>
            <li>
              <strong>Step 4 — View it in HashPack.</strong> It lands as a
              real HTS NFT in your wallet — view it in your HashPack NFT
              gallery.
            </li>
          </ol>

          {data.nfts.length === 0 ? (
            <p className="pv-empty">No NFTs minted in this collection yet — check back soon.</p>
          ) : (
            <div className="pv-nft-grid">
              {data.nfts.map((n) => (
                <article key={n.serial} className="pv-nft-card">
                  {n.imageUrl ? (
                    <img
                      src={n.imageUrl}
                      alt={n.name ?? `NFT serial ${n.serial}`}
                      loading="lazy"
                      decoding="async"
                      className="pv-nft-img"
                    />
                  ) : (
                    <div className="pv-nft-img pv-nft-img-missing" aria-hidden="true">
                      <IconGrid size={28} />
                    </div>
                  )}
                  <div className="pv-nft-card-body">
                    <div className="pv-nft-name">{n.name ?? `#${n.serial}`}</div>
                    <div className="pv-muted">Serial {n.serial}</div>
                    <a href={n.hashscanUrl} target="_blank" rel="noreferrer" className="pv-link">
                      HashScan <IconExternal size={14} />
                    </a>
                  </div>
                </article>
              ))}
            </div>
          )}

          <p className="pv-muted pv-nft-own">
            True ownership: once it&apos;s yours, hold it, view it in
            HashPack, or send it peer-to-peer to anyone — no restrictions.
            You can also relist it in the marketplace; the resale pays you
            (the lister) 98%.
          </p>
        </>
      )}
    </section>
  );
}
