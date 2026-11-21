import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/seo";
import SellClient from "./SellClient";

export const metadata: Metadata = buildPageMetadata({
  title: "Sell — Marketplace — Voicescape Town Hall",
  description: "List an item for sale — buyers pay you directly.",
  url: "/marketplace/sell",
});

export default function SellPage() {
  return <SellClient />;
}
