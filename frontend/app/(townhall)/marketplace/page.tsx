import type { Metadata } from "next";
import MarketplaceClient from "./MarketplaceClient";

export const metadata: Metadata = {
  title: "Marketplace — Voicescape Town Hall",
  description: "Buy and sell with atomic direct sales — no escrow.",
};

export default function MarketplacePage() {
  return <MarketplaceClient />;
}
