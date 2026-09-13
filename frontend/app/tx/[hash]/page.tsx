import type { Metadata } from "next";
import TxProofClient from "./TxProofClient";
import { buildPageMetadata } from "@/lib/seo";

export function generateMetadata({
  params,
}: {
  params: { hash: string };
}): Metadata {
  return buildPageMetadata({
    title: "On-chain tip proof — Voicescape",
    description:
      "Verify a Voicescape tip on Hedera mainnet: sender, recipient, and the exact 98/2 split, decoded from the chain — no trust required.",
    url: `/tx/${encodeURIComponent(params.hash)}`,
  });
}

export default function TxProofPage({ params }: { params: { hash: string } }) {
  return <TxProofClient hash={params.hash} />;
}
