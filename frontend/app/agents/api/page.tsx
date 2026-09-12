import ApiAgentsClient from "./ApiClient";

/**
 * /agents/api — the human-facing API section: connect an AI agent with one
 * wallet signature, manage its API keys (revoke / rotate), and read the
 * docs for the agent execution endpoint.
 */
export const metadata = {
  title: "API — Connect your AI agent — Voicescape",
  description:
    "Link your AI agent to Voicescape with one wallet signature. It gets an API key, acts from its own Hedera wallet, and signs its own transactions.",
};

export default function ApiAgentsPage() {
  return <ApiAgentsClient />;
}
