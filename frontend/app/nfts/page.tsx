/**
 * /nfts — the platform NFT gallery.
 *
 * Every collection here was created through the Voicescape NFT builder
 * (create_nft_drop / finalize_nft_drop) and registered ONLY after its
 * creation was verified on the Hedera mirror node. The registry is just
 * an index of token ids — everything rendered below (name, supply,
 * artwork, ownership) is re-read LIVE from the mirror node, and prices
 * come from live marketplace listings. Nothing decorative: when the
 * registry is empty, the page says so.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { listNftRegistry, type NftRegistryEntry } from "@/lib/server/nft-registry";
import { getNftCollection, type NftCollectionInfo } from "@/lib/server/mcp-tools-nft";
import { listMarketplaceTool, type MarketplaceListingView } from "@/lib/server/mcp-tools-misc";
import "../../components/renderer.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Voicescape NFT Builder",
  description:
    "NFT collections created with the Voicescape NFT builder on Hedera — live from the mirror node, sold peer-to-peer with a 98/2 split and no escrow.",
};

/** Serial named in a listing's description ("HTS NFT 0.0.x serial 3"). */
function listingSerial(listing: MarketplaceListingView): number | null {
  const m = /serial\s+#?(\d+)/i.exec(listing.description);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

interface CollectionView {
  entry: NftRegistryEntry;
  info: NftCollectionInfo | null;
  floorUsdCents: number | null;
  bySerial: Map<number, MarketplaceListingView>;
}

async function loadCollection(entry: NftRegistryEntry): Promise<CollectionView> {
  const [infoRes, marketRes] = await Promise.all([
    getNftCollection({ token_id: entry.tokenId }),
    listMarketplaceTool({ q: entry.tokenId, category: "digital", limit: 100 }),
  ]);
  const info = "error" in infoRes ? null : infoRes;
  const listings = "error" in marketRes ? [] : marketRes.listings;
  const bySerial = new Map<number, MarketplaceListingView>();
  let floor: number | null = null;
  for (const l of listings) {
    if (l.status !== "active") continue;
    if (!l.description.includes(entry.tokenId)) continue;
    const serial = listingSerial(l);
    if (serial === null) continue;
    if (!bySerial.has(serial)) bySerial.set(serial, l);
    floor = floor === null ? l.priceUsdCents : Math.min(floor, l.priceUsdCents);
  }
  return { entry, info, floorUsdCents: floor, bySerial };
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default async function NftsPage() {
  const entries = await listNftRegistry();
  const collections = await Promise.all(entries.map(loadCollection));

  return (
    <main
      style={{
        maxWidth: 1080,
        margin: "0 auto",
        padding: "40px 20px 80px",
        color: "var(--vs-text)",
      }}
    >
      <p className="vs-mono" style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--vs-muted)", margin: 0 }}>
        Hedera mainnet · live from the mirror node
      </p>
      <h1 style={{ fontSize: "clamp(30px, 6vw, 42px)", fontWeight: 800, letterSpacing: "-0.02em", margin: "10px 0 0" }}>
        Voicescape NFT Builder
      </h1>
      <p style={{ color: "var(--vs-muted)", fontSize: 15.5, lineHeight: 1.65, margin: "12px 0 0", maxWidth: "42em" }}>
        Collections created with the Voicescape NFT builder — by humans and AI agents alike.
        Creators own their collections outright (treasury, supply key, and admin are theirs).
        Sales settle peer-to-peer through the Tips contract: 98% to the seller, 2% to the
        treasury, no escrow.{" "}
        <Link href="/builder?create=nft" style={{ color: "var(--vs-accent, #8f7bff)" }}>
          Create your own drop →
        </Link>
      </p>

      {collections.length === 0 ? (
        <div
          style={{
            marginTop: 36,
            border: "1px solid var(--vs-border)",
            borderRadius: 12,
            padding: "28px 24px",
            background: "rgba(255,255,255,0.03)",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700 }}>No drops yet</h2>
          <p style={{ color: "var(--vs-muted)", lineHeight: 1.65, margin: "8px 0 0", maxWidth: "38em" }}>
            No NFT drops have been created through Voicescape yet. The first one lands here
            the moment its creation is verified on-chain. Create yours in the{" "}
            <Link href="/builder?create=nft" style={{ color: "var(--vs-accent, #8f7bff)" }}>builder</Link>{" "}
            or with the <span className="vs-mono">create_nft_drop</span> MCP tool — one signing
            package, a 1 HBAR creation fee plus Hedera network fees from your wallet, and
            you own everything.
          </p>
        </div>
      ) : (
        collections.map(({ entry, info, floorUsdCents, bySerial }) => (
          <section
            key={entry.tokenId}
            style={{
              marginTop: 36,
              border: "1px solid var(--vs-border)",
              borderRadius: 12,
              padding: "24px",
              background: "rgba(255,255,255,0.03)",
            }}
            aria-label={info?.name ?? entry.name}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline", justifyContent: "space-between" }}>
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>
                {info?.name ?? entry.name}{" "}
                <span className="vs-mono" style={{ fontSize: 13, color: "var(--vs-muted)", fontWeight: 500 }}>
                  {info?.symbol ?? entry.symbol} · {entry.tokenId}
                </span>
              </h2>
              <div style={{ display: "flex", gap: 14, fontSize: 13.5, color: "var(--vs-muted)", flexWrap: "wrap" }}>
                <span>
                  by{" "}
                  <Link href={`/${entry.creatorUsername}`} style={{ color: "var(--vs-accent, #8f7bff)" }}>
                    {entry.creatorUsername}
                  </Link>
                </span>
                {info && (
                  <span>
                    {info.totalSupply ?? "0"} minted{info.maxSupply ? ` of ${info.maxSupply}` : ""}
                  </span>
                )}
                {floorUsdCents !== null && <span>Floor {usd(floorUsdCents)}</span>}
                <a
                  href={info?.hashscanUrl ?? `https://hashscan.io/mainnet/token/${entry.tokenId}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--vs-accent, #8f7bff)" }}
                >
                  Verify on HashScan ↗
                </a>
              </div>
            </div>

            {info === null ? (
              <p style={{ color: "var(--vs-muted)", margin: "14px 0 0", lineHeight: 1.6 }}>
                This collection is registered but the mirror node could not be read just now —
                refresh in a moment.{" "}
                <a href={`https://hashscan.io/mainnet/token/${entry.tokenId}`} target="_blank" rel="noreferrer" style={{ color: "var(--vs-accent, #8f7bff)" }}>
                  View it on HashScan ↗
                </a>
              </p>
            ) : info.nfts.length === 0 ? (
              <p style={{ color: "var(--vs-muted)", margin: "14px 0 0", lineHeight: 1.6 }}>
                Collection created — no pieces minted yet. They appear here live as soon as
                the creator&apos;s mint lands.
              </p>
            ) : (
              <div className="pv-nft-grid" style={{ marginTop: 16 }}>
                {info.nfts.map((nft) => {
                  const listing = bySerial.get(nft.serial);
                  return (
                    <div key={nft.serial} className="pv-nft-card">
                      {nft.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img className="pv-nft-img" src={nft.imageUrl} alt={nft.name ?? `Serial ${nft.serial}`} loading="lazy" />
                      ) : (
                        <div className="pv-nft-img pv-nft-img-missing">Art unavailable</div>
                      )}
                      <div className="pv-nft-card-body">
                        <div className="pv-nft-name">{nft.name ?? `Serial #${nft.serial}`}</div>
                        <div className="pv-nft-meta">
                          <span>#{nft.serial}</span>
                          {listing ? (
                            <span>
                              {usd(listing.priceUsdCents)} ·{" "}
                              <a href={listing.url} style={{ color: "var(--vs-accent, #8f7bff)", fontWeight: 700 }}>
                                Buy
                              </a>
                            </span>
                          ) : (
                            <span>Not for sale</span>
                          )}
                          <a href={nft.hashscanUrl} target="_blank" rel="noreferrer">
                            HashScan ↗
                          </a>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ))
      )}
    </main>
  );
}
