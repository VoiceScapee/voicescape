/**
 * HCS-10 (OpenConvAI) helpers for Voicescape agents.
 *
 * HCS-10 is Hedera's open standard for AI-agent identity, discovery, and
 * agent-to-agent messaging. Every HCS-10 agent owns:
 *   - an **inbound topic**  — receives connection requests (public/fee-gated)
 *   - an **outbound topic** — the agent's public activity log (submit-keyed)
 *   - a **registration**    — a `register` message on the shared registry topic
 *   - **connection topics** — private 1:1 channels, created per conversation
 *
 * Topic memos follow `hcs-10:{indexed}:{ttl}:{type}:[params]`.
 * Registry messages follow `{"p":"hcs-10","op":"...","operator_id":"...","data":"..."}`.
 *
 * This module builds and parses those formats. It does NOT submit
 * transactions — topic creation and registration are done by the agent's
 * own tooling (e.g. `@hashgraphonline/standards-sdk`) signing with the
 * agent's Hedera key. See `public/agents.md` for the full flow.
 *
 * Refs:
 * - https://github.com/hashgraph-online/hcs-improvement-proposals (HCS-10)
 * - https://dev.to/noopy420/how-to-register-an-ai-agent-on-hedera-using-hcs-10-a-step-by-step-guide-4bg2
 */

/** Topic roles in the HCS-10 memo `type` slot. */
export const HCS10_TOPIC_TYPE = {
  /** Receives connection requests. Public, controlled, or fee-based. */
  INBOUND: 0,
  /** Agent's public activity log. Submit-key restricted to the agent. */
  OUTBOUND: 1,
  /** Private agent-to-agent channel. Threshold-key controlled. */
  CONNECTION: 2,
} as const;
export type Hcs10TopicType =
  (typeof HCS10_TOPIC_TYPE)[keyof typeof HCS10_TOPIC_TYPE];

/** Operations in HCS-10 registry/connection messages (`op` field). */
export const HCS10_OP = {
  REGISTER: "register",
  CONNECTION_REQUEST: "connection_request",
  CONNECTION_CREATED: "connection_created",
  MESSAGE: "message",
  TRANSACTION: "transaction",
  CLOSE_CONNECTION: "close_connection",
} as const;
export type Hcs10Op = (typeof HCS10_OP)[keyof typeof HCS10_OP];

export interface Hcs10TopicMemo {
  /** 1 = mirror node indexes this topic, 0 = not indexed. */
  indexed: 0 | 1;
  /** TTL hint in seconds; 0 = none. */
  ttl: number;
  /** One of HCS10_TOPIC_TYPE. */
  type: Hcs10TopicType;
  /** Optional trailing params, e.g. the owning account id. */
  params?: string;
}

const MEMO_RE = /^hcs-10:([01]):(\d+):([012])(?::(.*))?$/;

/**
 * Build an HCS-10 topic memo: `hcs-10:{indexed}:{ttl}:{type}:[params]`.
 * Topic memos are limited to 100 bytes — this throws if the result is
 * too long or a field is out of range.
 */
export function buildHcs10TopicMemo(m: Hcs10TopicMemo): string {
  if (m.indexed !== 0 && m.indexed !== 1) {
    throw new Error("hcs10: indexed must be 0 or 1");
  }
  if (!Number.isInteger(m.ttl) || m.ttl < 0) {
    throw new Error("hcs10: ttl must be a non-negative integer");
  }
  if (!Object.values(HCS10_TOPIC_TYPE).includes(m.type)) {
    throw new Error("hcs10: unknown topic type");
  }
  const params = (m.params ?? "").trim();
  if (params.includes(":")) {
    // A colon inside params would corrupt the memo structure on parse.
    throw new Error("hcs10: params must not contain ':'");
  }
  const memo = `hcs-10:${m.indexed}:${m.ttl}:${m.type}${params ? `:${params}` : ""}`;
  if (memo.length > 100) {
    throw new Error(`hcs10: memo exceeds 100 bytes (${memo.length})`);
  }
  return memo;
}

/** Parse an HCS-10 topic memo. Returns null when it is not a valid memo. */
export function parseHcs10TopicMemo(memo: string): Hcs10TopicMemo | null {
  const m = MEMO_RE.exec(memo.trim());
  if (!m) return null;
  const parsed: Hcs10TopicMemo = {
    indexed: m[1] === "1" ? 1 : 0,
    ttl: Number(m[2]),
    type: Number(m[3]) as Hcs10TopicType,
  };
  if (m[4] !== undefined && m[4] !== "") parsed.params = m[4];
  return parsed;
}

/** True when a topic memo is a well-formed HCS-10 memo. */
export function isHcs10TopicMemo(memo: string): boolean {
  return parseHcs10TopicMemo(memo) !== null;
}

export interface Hcs10RegisterMessage {
  p: "hcs-10";
  op: typeof HCS10_OP.REGISTER;
  /** "<inboundTopicId>@<agentAccountId>", e.g. "0.0.1234@0.0.5678". */
  operator_id: string;
  /**
   * Agent profile payload: HCS-11 profile JSON, or an HCS-1 reference
   * (e.g. `hcs://1/<topicId>`) when the profile is large.
   */
  data: string;
  /** Optional human-readable memo. */
  m?: string;
}

const OPERATOR_ID_RE = /^0\.0\.\d+@0\.0\.\d+$/;

/**
 * Build the `register` message an agent submits to the HCS-10 registry
 * topic. Throws on malformed operator ids or empty profile data.
 */
export function buildHcs10RegisterMessage(args: {
  inboundTopicId: string;
  accountId: string;
  /** HCS-11 profile JSON string, or an HCS-1 reference for large profiles. */
  profileData: string;
  memo?: string;
}): Hcs10RegisterMessage {
  const operatorId = `${args.inboundTopicId}@${args.accountId}`;
  if (!OPERATOR_ID_RE.test(operatorId)) {
    throw new Error(`hcs10: malformed operator_id "${operatorId}"`);
  }
  if (!args.profileData || args.profileData.trim() === "") {
    throw new Error("hcs10: profile data must not be empty");
  }
  const msg: Hcs10RegisterMessage = {
    p: "hcs-10",
    op: HCS10_OP.REGISTER,
    operator_id: operatorId,
    data: args.profileData,
  };
  if (args.memo) msg.m = args.memo;
  return msg;
}

/**
 * Voicescape agent profile (HCS-11 style). Ties the on-chain HCS-10
 * identity to the agent's Voicescape page so humans can verify who
 * they're talking to.
 */
export interface VoicescapeAgentProfile {
  /** Display name of the agent. */
  name: string;
  /** What the agent does, in one or two sentences. */
  description: string;
  /** Voicescape page username (without @). */
  voicescapeUsername: string;
  /** Full public page URL, e.g. https://voicescape.vercel.app/my-agent */
  voicescapePageUrl: string;
  /** Capability tags, e.g. ["text-generation", "tipping"]. */
  capabilities: string[];
  /** Model/provider label, e.g. "claude-3". Optional. */
  model?: string;
  /** Filled in after the agent creates its HCS-10 topics. */
  inboundTopicId?: string;
  /** Filled in after the agent creates its HCS-10 topics. */
  outboundTopicId?: string;
}

/** Build a Voicescape agent profile payload (serialized as the `data` of a register message). */
export function buildVoicescapeAgentProfile(
  p: VoicescapeAgentProfile,
): string {
  const name = p.name.trim();
  const description = p.description.trim();
  const username = p.voicescapeUsername.trim().replace(/^@/, "").toLowerCase();
  if (!name) throw new Error("hcs10: profile name must not be empty");
  if (!description) throw new Error("hcs10: profile description must not be empty");
  if (!/^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/.test(username)) {
    throw new Error(`hcs10: invalid Voicescape username "${p.voicescapeUsername}"`);
  }
  if (!Array.isArray(p.capabilities) || p.capabilities.length === 0) {
    throw new Error("hcs10: at least one capability is required");
  }
  return JSON.stringify({
    name,
    description,
    voicescape: {
      username,
      pageUrl: p.voicescapePageUrl,
    },
    capabilities: p.capabilities,
    ...(p.model ? { model: p.model } : {}),
    ...(p.inboundTopicId ? { inboundTopicId: p.inboundTopicId } : {}),
    ...(p.outboundTopicId ? { outboundTopicId: p.outboundTopicId } : {}),
  });
}

/**
 * HCS-10 registry topic per network.
 *
 * Testnet value is the OpenConvAI default used by community tooling.
 * Mainnet: resolve via the official standards SDK
 * (`@hashgraphonline/standards-sdk`) or the hashgraphonline docs — this
 * returns null rather than guessing an id.
 */
export function getHcs10RegistryTopic(
  network: "mainnet" | "testnet",
): string | null {
  if (network === "testnet") return "0.0.7311321";
  return null;
}

/**
 * Convenience: the ordered, no-key-needed checklist for registering a
 * Voicescape agent on HCS-10. Pure data — the caller performs the
 * on-chain steps with their own Hedera key.
 */
export function hcs10RegistrationSteps(args: {
  agentName: string;
  accountId: string;
  network: "mainnet" | "testnet";
}): string[] {
  const registry = getHcs10RegistryTopic(args.network);
  return [
    `1. Create an inbound topic with memo "${buildHcs10TopicMemo({ indexed: 1, ttl: 0, type: HCS10_TOPIC_TYPE.INBOUND, params: args.accountId })}" (public; add a fee config to monetize connections).`,
    `2. Create an outbound topic with memo "${buildHcs10TopicMemo({ indexed: 1, ttl: 0, type: HCS10_TOPIC_TYPE.OUTBOUND })}" (submit key = your agent key).`,
    `3. Build your agent profile with buildVoicescapeAgentProfile() and serialize it as the register message data.`,
    registry
      ? `4. Submit buildHcs10RegisterMessage() to registry topic ${registry}.`
      : `4. Resolve the ${args.network} HCS-10 registry topic via @hashgraphonline/standards-sdk, then submit buildHcs10RegisterMessage() to it.`,
    `5. Your agent "${args.agentName}" is now discoverable by every HCS-10 agent on Hedera.`,
  ];
}
