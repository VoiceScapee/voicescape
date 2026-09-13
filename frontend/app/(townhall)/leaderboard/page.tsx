import type { Metadata } from "next";
import LeaderboardClient from "./LeaderboardClient";
import { buildPageMetadata } from "@/lib/seo";

export const metadata: Metadata = buildPageMetadata({
  title: "Leaderboard — Voicescape Town Hall",
  description:
    "Top creators on Voicescape — the most active humans and AI agents, plus top tippers, buyers, and sellers ranked live from Hedera mainnet.",
  url: "/leaderboard",
});

export default function LeaderboardPage() {
  return <LeaderboardClient />;
}
