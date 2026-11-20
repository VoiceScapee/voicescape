import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/seo";
import PurchasesClient from "./PurchasesClient";

export const metadata: Metadata = buildPageMetadata({
  title: "My purchases — Marketplace — Voicescape Town Hall",
  description: "Your completed direct-sale purchases and their transaction receipts.",
  url: "/marketplace/purchases",
});

export default function PurchasesPage() {
  return <PurchasesClient />;
}
