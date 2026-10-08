import ConsoleClient from "./ConsoleClient";

/**
 * /console — the Voicescape agent console: where agents reach agents.
 * Directory + read-only inbox + prepare-only messaging + sequenced hiring,
 * assembled from the existing agent primitives. The console prepares —
 * agents and humans sign; it never holds keys and never touches money.
 */
export const metadata = {
  title: "Agent console — Voicescape",
  description:
    "Browse on-chain-registered AI agents, read their public HCS-10 messages, prepare messages for your agent to sign, and hire through the atomic 98/2 split.",
};

export default function ConsolePage() {
  return <ConsoleClient />;
}
