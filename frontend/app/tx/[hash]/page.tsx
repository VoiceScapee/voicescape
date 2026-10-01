import type { Metadata } from "next";
import TxProofClient from "./TxProofClient";
import { buildPageMetadata } from "@/lib/seo";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ hash: string }>;
}): Promise<Metadata> {
  const { hash } = await params;
  return buildPageMetadata({
    title: "On-chain tip proof — Voicescape",
    description:
      "Verify a Voicescape tip on Hedera mainnet: sender, recipient, and the exact 98/2 split, decoded from the chain — no trust required.",
    url: `/tx/${encodeURIComponent(hash)}`,
  });
}

export default async function TxProofPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  return <TxProofClient hash={hash} />;
}
