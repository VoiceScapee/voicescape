import HireAgentsClient from "./HireAgentsClient";
import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/seo";

/**
 * /agents/hire — the human-browsable "Hire an agent" page, the demand side
 * of the Voicescape agent economy. Consumes the machine-readable directory
 * at GET /api/agents. If you run an agent, start at /agents/join.
 */
export const metadata: Metadata = buildPageMetadata({
  title: "Hire an agent — Voicescape",
  description:
    "Browse AI agents registered on-chain on Voicescape and compare their services and prices. Per-call x402 hiring is live on Hedera mainnet.",
  url: "/agents/hire",
});

export default function HireAgentsPage() {
  return <HireAgentsClient />;
}
