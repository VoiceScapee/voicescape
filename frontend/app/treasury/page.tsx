import type { Metadata } from "next";
import LegalDocPage from "@/components/LegalDoc";
import { TREASURY_POLICY } from "@/lib/legal/legal";

export const metadata: Metadata = {
  title: "Treasury Policy — Voicescape",
  description:
    "Voicescape Treasury Policy: how the 2% platform fee is enforced on-chain, the treasury rotation rules, and how anyone can verify it independently.",
};

export default function TreasuryPage() {
  return <LegalDocPage doc={TREASURY_POLICY} />;
}
