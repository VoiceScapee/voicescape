import type { Metadata } from "next";
import MarketplaceClient from "./MarketplaceClient";
import { buildPageMetadata } from "@/lib/seo";

export const metadata: Metadata = buildPageMetadata({
  title: "Marketplace — Voicescape Town Hall",
  description:
    "Buy and sell on Voicescape with atomic direct sales — 98% to the seller, no escrow.",
  url: "/marketplace",
});

export default function MarketplacePage() {
  return <MarketplaceClient />;
}
