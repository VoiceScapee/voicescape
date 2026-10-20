"use client";

/**
 * "Create NFT drop" — the human builder panel for the v2 NFT pipeline.
 *
 * Drives the SAME backend as the MCP tools (no parallel logic):
 *   POST /api/nfts/drop-prepare  → create_nft_drop (pin refs in, signing
 *                                  package out: [1 HBAR fee, TokenCreate])
 *   wallet signs both via submitPreparedTx (the existing pipeline)
 *   POST /api/nfts/drop-finalize → finalize_nft_drop phase 1 (verifies on
 *                                  the mirror node, registers the drop,
 *                                  returns the mint package)
 *   wallet signs the mint
 *   POST /api/nfts/drop-finalize → phase 2 (serials resolved; priced
 *                                  pieces listed through the standard web
 *                                  sell flow — HCS submit + listings API,
 *                                  the exact path SellClient uses)
 *   onAttachGallery(tokenId)     → the parent adds the nftGallery block
 *
 * The server never holds keys; the creator pays the 1 HBAR creation fee
 * plus all Hedera network fees from their own wallet. Copy says so.
 */
import { useState } from "react";
import { useWallet } from "@/lib/wallet";
import { pinImageFile } from "@/lib/ipfs";
import { submitPreparedTx } from "@/lib/prepared-tx";
import { useHcsSubmit } from "@/components/townhall/useHcsSubmit";
import { accountToEvmAddress, makeTownhallId, postJson } from "@/lib/townhall";

interface PieceInput {
  name: string;
  priceUsd: string;
  cid: string | null;
  mime: string | null;
  fileName: string | null;
  uploading: boolean;
}

interface ListingPayload {
  title: string;
  description: string;
  price_usd_cents: number;
  ipfs_hash: string;
  token_id: string;
  serial: number;
}

interface DonePiece {
  name: string;
  serial?: number;
}

const MAX_PIECES = 10;

async function postRoute<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(data.error);
  }
  return data as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Finalize with mirror-lag retries: a just-submitted tx can take a few
 *  seconds to become readable; only "not visible yet" errors retry. */
async function finalizeWithRetry<T>(body: unknown, tries = 12): Promise<T> {
  let lastErr: Error | null = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await postRoute<T>("/api/nfts/drop-finalize", body);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (!/not found on the mirror node yet|not visible|not visible on the mirror node yet/i.test(lastErr.message)) {
        throw lastErr;
      }
      await sleep(4000);
    }
  }
  throw lastErr ?? new Error("finalize did not complete — try again in a moment");
}

export default function NftDropCreator({
  username,
  onAttachGallery,
}: {
  /** The blockpage username being built (the drop's creator page). */
  username: string;
  /** Called once the drop is live: parent appends the gallery block. */
  onAttachGallery: (tokenId: string, title: string) => void;
}) {
  const { account } = useWallet();
  const hcs = useHcsSubmit();
  const [name, setName] = useState("");
  const [pieces, setPieces] = useState<PieceInput[]>([
    { name: "", priceUsd: "", cid: null, mime: null, fileName: null, uploading: false },
  ]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    tokenId: string;
    pieces: DonePiece[];
    payloads: ListingPayload[];
  } | null>(null);
  const [listed, setListed] = useState<Record<number, boolean>>({});
  const [listingBusy, setListingBusy] = useState<number | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);

  const setPiece = (i: number, patch: Partial<PieceInput>) =>
    setPieces((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const uploadPiece = async (i: number, file: File) => {
    setPiece(i, { uploading: true });
    setError(null);
    try {
      const cid = await pinImageFile(file);
      setPiece(i, {
        cid,
        mime: file.type || null,
        fileName: file.name,
        uploading: false,
        name: pieces[i].name || file.name.replace(/\.[^.]+$/, ""),
      });
    } catch (e) {
      setPiece(i, { uploading: false });
      setError(e instanceof Error ? e.message : "Upload failed — try again.");
    }
  };

  const ready =
    !!account &&
    username.trim().length >= 3 &&
    name.trim().length >= 3 &&
    pieces.length >= 1 &&
    pieces.every((p) => p.cid && p.name.trim().length >= 1 && !p.uploading);

  const create = async () => {
    if (!ready || !account) return;
    setError(null);
    try {
      setBusy("Preparing your drop…");
      const pkg = await postRoute<{
        drop_id: string;
        sign_in_order: Array<{ kind: string; unsignedTxBytes: string; transactionId: string }>;
      }>("/api/nfts/drop-prepare", {
        agent_username: username.trim().toLowerCase(),
        name: name.trim(),
        pieces: pieces.map((p) => ({
          name: p.name.trim(),
          image_cid: p.cid,
          image_mime: p.mime ?? undefined,
          price_usd_cents: p.priceUsd.trim()
            ? Math.round(Number(p.priceUsd) * 100)
            : undefined,
        })),
      });

      for (const step of pkg.sign_in_order) {
        setBusy(
          step.kind === "creation_fee"
            ? "Sign the 1 HBAR creation fee in your wallet…"
            : "Sign the collection creation in your wallet…",
        );
        await submitPreparedTx(
          {
            transactionList: step.unsignedTxBytes,
            signerAccountId: `hedera:mainnet:${account}`,
            transactionId: step.transactionId,
          },
          { expectedOwnerAccountId: account },
        );
      }

      setBusy("Verifying on-chain and registering your drop…");
      const phase1 = await finalizeWithRetry<{
        token_id: string;
        mint: { unsignedTxBytes: string; transactionId: string };
      }>({
        agent_username: username.trim().toLowerCase(),
        drop_id: pkg.drop_id,
        fee_tx_id: pkg.sign_in_order[0].transactionId,
        create_tx_id: pkg.sign_in_order[1].transactionId,
      });

      setBusy("Sign the mint in your wallet — this creates your NFTs…");
      await submitPreparedTx(
        {
          transactionList: phase1.mint.unsignedTxBytes,
          signerAccountId: `hedera:mainnet:${account}`,
          transactionId: phase1.mint.transactionId,
        },
        { expectedOwnerAccountId: account },
      );

      setBusy("Resolving your NFT serials…");
      const phase2 = await finalizeWithRetry<{
        pieces: DonePiece[];
        listing_payloads: ListingPayload[];
      }>({
        agent_username: username.trim().toLowerCase(),
        drop_id: pkg.drop_id,
        mint_tx_id: phase1.mint.transactionId,
        prepare_listings: false,
      });

      onAttachGallery(phase1.token_id, name.trim());
      setDone({
        tokenId: phase1.token_id,
        pieces: phase2.pieces,
        payloads: phase2.listing_payloads ?? [],
      });
      setBusy(null);
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : "Something went wrong — try again.");
    }
  };

  const listPiece = async (payload: ListingPayload, idx: number) => {
    if (!account) return;
    setListingError(null);
    setListingBusy(idx);
    try {
      const id = makeTownhallId(payload.title);
      const hcsTxId = await hcs.submit("market", {
        v: 1,
        kind: "listing",
        ts: new Date().toISOString(),
        author: username.trim().toLowerCase(),
        id,
        seller: accountToEvmAddress(account),
        sellerUsername: username.trim().toLowerCase(),
        title: payload.title,
        description: payload.description,
        priceUsdCents: payload.price_usd_cents,
        goodsType: "digital",
        ipfsHash: payload.ipfs_hash,
        status: "active",
      });
      if (!hcsTxId) {
        setListingError("Listing submit didn't complete — check your wallet and try again.");
        return;
      }
      await postJson("/api/townhall/listings", {
        seller: accountToEvmAddress(account),
        sellerUsername: username.trim().toLowerCase(),
        id,
        title: payload.title,
        description: payload.description,
        priceUsdCents: payload.price_usd_cents,
        goodsType: "digital",
        ipfsHash: payload.ipfs_hash,
        hcsTxId,
      });
      setListed((m) => ({ ...m, [idx]: true }));
    } catch (e) {
      setListingError(
        e instanceof Error ? e.message : "The listing couldn't be published — try again.",
      );
    } finally {
      setListingBusy(null);
    }
  };

  if (done) {
    return (
      <section aria-label="NFT drop created" style={{ marginTop: 16 }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 17 }}>Your drop is live 🎉</h3>
        <p style={{ margin: 0, lineHeight: 1.6 }}>
          Collection <span className="vs-mono">{done.tokenId}</span> is minted to your wallet
          and registered — the NFT Gallery block was added to your page (publish below if
          your page isn&apos;t live yet) and the drop is on the{" "}
          <a href="/nfts" target="_blank" rel="noreferrer">/nfts page</a>.{" "}
          <a
            href={`https://hashscan.io/mainnet/token/${done.tokenId}`}
            target="_blank"
            rel="noreferrer"
          >
            Verify on HashScan ↗
          </a>
        </p>
        <ul style={{ margin: "10px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
          {done.pieces.map((p, i) => (
            <li key={i}>
              {p.name}
              {p.serial ? ` — serial #${p.serial}` : ""}
            </li>
          ))}
        </ul>
        {done.payloads.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <p style={{ margin: "0 0 8px", fontWeight: 600 }}>List your priced pieces:</p>
            {done.payloads.map((payload, i) => (
              <div
                key={i}
                style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}
              >
                <span>
                  {payload.title} (#{payload.serial}) — ${(payload.price_usd_cents / 100).toFixed(2)}
                </span>
                {listed[i] ? (
                  <span>Listed ✅</span>
                ) : (
                  <button
                    type="button"
                    className="vs-btn vs-btn-primary"
                    disabled={listingBusy === i || hcs.phase.kind === "submitting"}
                    onClick={() => void listPiece(payload, i)}
                  >
                    {listingBusy === i ? "Sign in wallet…" : "List for sale"}
                  </button>
                )}
              </div>
            ))}
            <p className="vs-hint" style={{ margin: 0 }}>
              Buyers pay through the listing — 98% lands in your wallet, 2% to the treasury,
              atomic on-chain. After a sale, deliver the serial from your page&apos;s gallery
              block (Gift) or your wallet.
            </p>
            {listingError && (
              <p className="vb-error" role="alert" style={{ marginTop: 8 }}>{listingError}</p>
            )}
          </div>
        )}
      </section>
    );
  }

  return (
    <section aria-label="Create NFT drop" style={{ marginTop: 16 }}>
      <h3 style={{ margin: "0 0 6px", fontSize: 17 }}>Create an NFT drop</h3>
      <p style={{ margin: "0 0 12px", lineHeight: 1.6 }}>
        Your own NFT collection on Hedera, minted to YOUR wallet — you are treasury, supply
        key, and admin. It shows up on your blockpage and on the platform{" "}
        <a href="/nfts" target="_blank" rel="noreferrer">/nfts page</a>. Sell pieces, gift
        them, or keep them.
      </p>

      <label className="vs-label" htmlFor="nft-drop-name">Collection name</label>
      <input
        id="nft-drop-name"
        className="vs-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Neon Tide"
        maxLength={100}
        disabled={!!busy}
      />
      {name.trim().length >= 3 && (
        <p className="vs-hint" style={{ marginTop: 4 }}>
          Ticker: {name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "—"} (derived
          from the name)
        </p>
      )}

      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        {pieces.map((p, i) => (
          <div
            key={i}
            style={{
              border: "1px solid var(--vs-border)",
              borderRadius: 10,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div className="vb-row" style={{ gap: 8 }}>
              <input
                className="vs-input"
                style={{ flex: 1, minWidth: 0 }}
                value={p.name}
                onChange={(e) => setPiece(i, { name: e.target.value })}
                placeholder={`Piece ${i + 1} name`}
                aria-label={`Piece ${i + 1} name`}
                maxLength={100}
                disabled={!!busy}
              />
              <input
                className="vs-input"
                style={{ width: 110 }}
                value={p.priceUsd}
                onChange={(e) => setPiece(i, { priceUsd: e.target.value.replace(/[^0-9.]/g, "") })}
                placeholder="Price $ (opt)"
                inputMode="decimal"
                aria-label={`Piece ${i + 1} price in USD (optional)`}
                disabled={!!busy}
              />
              {pieces.length > 1 && (
                <button
                  type="button"
                  className="vs-btn vs-btn-ghost"
                  onClick={() => setPieces((ps) => ps.filter((_, j) => j !== i))}
                  disabled={!!busy}
                  aria-label={`Remove piece ${i + 1}`}
                >
                  Remove
                </button>
              )}
            </div>
            <div className="vb-row" style={{ gap: 8, alignItems: "center" }}>
              <label className="vs-btn vs-btn-ghost" style={{ cursor: "pointer" }}>
                {p.uploading ? "Uploading…" : p.cid ? "Replace artwork" : "Upload artwork"}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={p.uploading || !!busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void uploadPiece(i, f);
                  }}
                />
              </label>
              {p.cid ? (
                <span className="vs-hint">
                  Pinned ✅ <span className="vs-mono" style={{ fontSize: 11 }}>{p.fileName ?? p.cid.slice(0, 14) + "…"}</span>
                </span>
              ) : (
                <span className="vs-hint">JPEG, PNG, GIF, or WebP up to 10 MB, pinned to IPFS</span>
              )}
            </div>
          </div>
        ))}
      </div>
      {pieces.length < MAX_PIECES && (
        <button
          type="button"
          className="vs-btn vs-btn-ghost"
          style={{ marginTop: 10 }}
          disabled={!!busy}
          onClick={() =>
            setPieces((ps) => [
              ...ps,
              { name: "", priceUsd: "", cid: null, mime: null, fileName: null, uploading: false },
            ])
          }
        >
          + Add piece
        </button>
      )}

      <div
        style={{
          marginTop: 16,
          border: "1px solid var(--vs-border)",
          borderRadius: 10,
          padding: 12,
          lineHeight: 1.65,
        }}
      >
        <strong>What you pay — one total from your wallet:</strong>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          <li>1 HBAR — Voicescape creation fee</li>
          <li>Hedera network fees — a few HBAR to create the collection, plus a fraction of a cent per piece to mint</li>
        </ul>
        <p style={{ margin: "6px 0 0" }}>
          Creating isn&apos;t free, and nothing is escrowed: you sign three transactions
          (fee, create, mint), the server never sees your keys, and you own everything.
        </p>      </div>

      <button
        type="button"
        className="vs-btn vs-btn-primary"
        style={{ marginTop: 14 }}
        disabled={!ready || !!busy}
        onClick={() => void create()}
      >
        {busy ?? "Create drop — sign in wallet"}
      </button>
      {!account && (
        <p className="vs-hint" style={{ marginTop: 8 }}>
          Connect your wallet (step before Publish) — the drop is created from it.
        </p>
      )}
      {account && username.trim().length < 3 && (
        <p className="vs-hint" style={{ marginTop: 8 }}>
          Set your blockpage username first — the drop belongs to that page.
        </p>
      )}
      {error && (
        <p className="vb-error" role="alert" style={{ marginTop: 10 }}>{error}</p>
      )}
    </section>
  );
}
