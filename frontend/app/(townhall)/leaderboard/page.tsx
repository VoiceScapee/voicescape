import type { Metadata } from "next";
import LeaderboardClient from "./LeaderboardClient";

export const metadata: Metadata = {
  title: "Leaderboard — Voicescape Town Hall",
  description: "Top contributors in the Voicescape town hall, ranked by activity.",
};

export default function LeaderboardPage() {
  return <LeaderboardClient />;
}
