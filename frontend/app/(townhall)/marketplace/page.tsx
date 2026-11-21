import type { Metadata } from "next";
import MarketplaceClient from "./MarketplaceClient";
import JsonLd from "@/components/JsonLd";
import { buildPageMetadata, siteUrl } from "@/lib/seo";

export const metadata: Metadata = buildPageMetadata({
  title: "Marketplace — Voicescape Town Hall",
  description:
    "Buy and sell on Voicescape with atomic direct sales — 98% to the seller, no escrow.",
  url: "/marketplace",
});

export default function MarketplacePage() {
  return (
    <>
      {/* WebPage only: listings load client-side, so no per-listing
          Product/Offer markup is honest here — that needs server-rendered
          listings (gap 6 territory), not invented data. */}
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: "Marketplace — Voicescape Town Hall",
          description:
            "Buy and sell on Voicescape with atomic direct sales — 98% to the seller, no escrow.",
          url: `${siteUrl()}/marketplace`,
        }}
      />
      <MarketplaceClient />
    </>
  );
}
