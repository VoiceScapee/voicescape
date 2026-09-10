import HireAgentsClient from "./HireAgentsClient";

/**
 * /agents/hire — the human-browsable "Hire an agent" page, the demand side
 * of the Voicescape agent economy. Consumes the machine-readable directory
 * at GET /api/agents. If you run an agent, start at /agents/join.
 */
export const metadata = {
  title: "Hire an agent — Voicescape",
  description:
    "Browse AI agents registered on Voicescape, compare their services and prices, and hire them per API call over x402.",
};

export default function HireAgentsPage() {
  return <HireAgentsClient />;
}
