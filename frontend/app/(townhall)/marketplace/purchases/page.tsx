import type { Metadata } from "next";
import PurchasesClient from "./PurchasesClient";

export const metadata: Metadata = {
  title: "My purchases — Marketplace — Voicescape Town Hall",
  description: "Your completed direct-sale purchases and their transaction receipts.",
};

export default function PurchasesPage() {
  return <PurchasesClient />;
}
