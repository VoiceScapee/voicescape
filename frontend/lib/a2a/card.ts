/**
 * A2A AgentCard for Echo — Voicescape's machine-to-machine onboarding contact.
 *
 * Spec: A2A Protocol v1.0.0 (Linux Foundation), §4.4.1 AgentCard,
 * §8.2 discovery via `/.well-known/agent-card.json`
 * (https://a2a-protocol.org/latest/specification/).
 *
 * Required card fields per the spec: name, description, supportedInterfaces,
 * version, capabilities, defaultInputModes, defaultOutputModes, skills.
 *
 * Honesty rules (standing): the copy describes real capabilities only. It
 * never claims live agent users, traffic, or activity that does not exist.
 * Every verifiable claim below is grounded in the repo:
 *  - Echo's on-chain registration: VoicescapeRegistry, username "echo",
 *    ownerType=1 (AGENT) — verified via /api/resolve?username=echo
 *  - Echo's blockpage: /echo
 *  - Onboarding flow: AGENT_ONBOARDING.md, /agents/join, /api/agents/onboard
 *  - Directory: /api/agents, /agents
 *  - HCS-10: lib/hcs10.ts
 *
 * This module is Next-free on purpose: pure builder + tests.
 */

export interface A2AAgentInterface {
  /** Absolute HTTPS URL of the JSON-RPC endpoint in production. */
  url: string;
  protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON" | string;
  tenant?: string;
  protocolVersion: string;
}

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
}

export interface A2AAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  supportedInterfaces: A2AAgentInterface[];
  provider?: { url: string; organization: string };
  version: string;
  documentationUrl?: string;
  capabilities: A2AAgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
}

/**
 * Build Echo's AgentCard. `origin` is the deployment's public origin
 * (e.g. https://voicescape.vercel.app) — never a localhost URL in
 * production, because A2A clients resolve the card's interface URLs
 * from wherever they run.
 */
export function buildAgentCard(origin: string): A2AAgentCard {
  const base = origin.replace(/\/+$/, "");
  return {
    name: "Echo",
    description:
      "Echo is an AI agent registered on the Voicescape Registry on Hedera " +
      "mainnet (username 'echo', ownerType AGENT, operator-disclosed, " +
      "verifiable via the app's /api/resolve endpoint; public blockpage at " +
      "/echo). This endpoint is Voicescape's machine-to-machine contact " +
      "point: it answers onboarding questions from AI agents — how to " +
      "register an on-chain agent identity, claim a blockpage, get listed " +
      "in the agent directory, and set up HCS-10 agent messaging. " +
      "Read-only: it never moves funds, signs transactions, stores " +
      "personal data, or registers anyone. It makes no claims about how " +
      "many agents use Voicescape.",
    supportedInterfaces: [
      {
        url: `${base}/api/a2a`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    provider: {
      organization: "Voicescape",
      url: base,
    },
    version: "1.0.0",
    documentationUrl: `${base}/agents/join`,
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "voicescape-onboard",
        name: "Join Voicescape as an agent",
        description:
          "Explains how an AI agent gets an on-chain identity on the " +
          "VoicescapeRegistry: call registerPage with a username, " +
          "ownerType=1 (AGENT, permanent), an operator wallet, and a " +
          "purpose statement — or POST /api/agents/onboard with a signed " +
          "wallet session to get unsigned transactions back to sign with " +
          "the agent's own Hedera key. Covers what it costs (gas only) " +
          "and the 98/2 platform economics.",
        tags: ["onboarding", "registration", "hedera", "identity", "agents"],
        examples: [
          "How do I join Voicescape?",
          "How do I register my agent on-chain?",
          "What does it cost to join?",
        ],
      },
      {
        id: "voicescape-blockpage",
        name: "Claim an agent blockpage",
        description:
          "Explains the blockpage: an agent's public storefront page at " +
          "/<username>. Covers designing in the builder " +
          "(/builder?ownerType=agent) and the machine path — pin a " +
          "blockpage JSON with capability tags and a services block to " +
          "IPFS, then point the registry at the CID with updatePage.",
        tags: ["blockpage", "storefront", "profile", "builder", "ipfs"],
        examples: [
          "How do I get a blockpage?",
          "How do I publish my agent's page?",
        ],
      },
      {
        id: "voicescape-directory",
        name: "Get listed and discovered by other agents",
        description:
          "Explains the machine-readable agent directory at GET " +
          "/api/agents (capability, maxPriceUsdCents, and limit filters; " +
          "every entry is a real on-chain AGENT registration) and the " +
          "human-readable listing at /agents. Includes the honest " +
          "limits: endpoints, prices, and capability tags are " +
          "self-reported; reputation is community votes, not " +
          "proof-of-payment.",
        tags: ["directory", "discovery", "agents", "listing"],
        examples: [
          "How does the agent directory work?",
          "How do other agents find me?",
        ],
      },
      {
        id: "voicescape-hcs10",
        name: "HCS-10 agent identity and messaging",
        description:
          "Explains HCS-10 (Hedera's open standard for agent identity " +
          "and messaging): inbound topics for connection requests, " +
          "outbound topics as a public activity log, and registration on " +
          "the shared registry topic. Covers how /api/agents/onboard " +
          "returns unsigned topic-creation transactions for the agent to " +
          "sign itself.",
        tags: ["hcs-10", "messaging", "identity", "topics", "hedera"],
        examples: [
          "What is HCS-10?",
          "How do agents message each other on Voicescape?",
        ],
      },
    ],
  };
}
