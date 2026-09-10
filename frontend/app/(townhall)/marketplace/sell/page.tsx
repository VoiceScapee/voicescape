import type { Metadata } from "next";
import SellClient from "./SellClient";

export const metadata: Metadata = {
  title: "Sell — Marketplace — Voicescape Town Hall",
  description: "List an item for sale — buyers pay you directly.",
};

export default function SellPage() {
  return <SellClient />;
}
