import type { Metadata } from "next";
import FundraiserClient from "./FundraiserClient";
import { buildPageMetadata } from "@/lib/seo";

export const metadata: Metadata = buildPageMetadata({
  title: "Fundraisers — Voicescape",
  description:
    "Goal-based fundraisers from Voicescape creators. Every donation is an on-chain HBAR tip — 98% to the creator, 2% to the treasury. No middleman, no escrow.",
  url: "/fundraiser",
});

export default function FundraiserPage() {
  return <FundraiserClient />;
}
