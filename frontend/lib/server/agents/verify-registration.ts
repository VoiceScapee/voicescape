/**
 * Read-only HCS-10 registration verifier.
 *
 * Answers: "did this agent actually complete HCS-10 registration?" by
 * checking the three on-chain artifacts every HCS-10 agent needs, using
 * only mirror-node REST reads (no keys, no chain writes, $0):
 *
 *   1. Inbound topic — created by the agent's account, memo parses as an
 *      HCS-10 inbound topic for that account (`hcs-10:0:<ttl>:0:<account>`).
 *   2. Outbound topic — memo parses as HCS-10 outbound (`hcs-10:0:<ttl>:1`).
 *   3. Registry registration — a `register` message with
 *      `operator_id == "<inboundTopicId>@<accountId>"` on the HCS-10
 *      registry topic. Reported as `unconfigured` (not a pass, not a
 *      fail) when no registry topic is configured — there is no canonical
 *      mainnet registry topic published in the (Draft) HCS-10 spec, so we
 *      never guess one (see getHcs10RegistryTopic).
 *
 * `verified` is true only when every *checkable* item passes. An
 * `unconfigured` registry check is excluded from the verdict and reported
 * explicitly — absence of a configured registry must never read as proof.
 */

import {
  getHcs10RegistryTopic,
  HCS10_TOPIC_TYPE,
  parseHcs10TopicMemo,
} from "@/lib/hcs10";

export type VerifyNetwork = "mainnet" | "testnet";

export interface TopicCheck {
  ok: boolean;
  topicId: string | null;
  memo: string | null;
  /** Human-readable evidence / reason. */
  detail: string;
  /** Non-failing observation, e.g. memo uses indexed=1 vs spec's 0. */
  note?: string;
}

export interface RegistryCheck {
  status: "confirmed" | "not_found" | "unconfigured";
  topicId: string | null;
  detail: string;
  evidence?: { consensusTimestamp: string; sequenceNumber: string };
}

export interface VerificationResult {
  username: string | null;
  accountId: string;
  network: VerifyNetwork;
  checks: {
    inboundTopic: TopicCheck;
    outboundTopic: TopicCheck;
    registryRegistration: RegistryCheck;
  };
  verified: boolean;
}

export class VerifierError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function mirrorBase(network: VerifyNetwork): string {
  return network === "mainnet"
    ? "https://mainnet.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new VerifierError(502, `mirror node unavailable (${res.status})`);
  }
  return res.json();
}

const ACCOUNT_RE = /^0\.0\.\d+$/;

/**
 * Find the agent's HCS-10 topics: topics associated with the account whose
 * memos parse as HCS-10 inbound (type 0, params == account) / outbound
 * (type 1). Pure predicate over mirror-node topic rows — exported for tests.
 */
export function matchAgentTopics(
  topics: Array<{ topic_id?: string; memo?: string | null }>,
  accountId: string,
): { inbound: { topicId: string; memo: string } | null; outbound: { topicId: string; memo: string } | null } {
  let inbound: { topicId: string; memo: string } | null = null;
  let outbound: { topicId: string; memo: string } | null = null;
  for (const t of topics) {
    const memo = (t.memo ?? "").trim();
    const topicId = t.topic_id ?? "";
    if (!memo || !topicId) continue;
    const parsed = parseHcs10TopicMemo(memo);
    if (!parsed) continue;
    if (parsed.type === HCS10_TOPIC_TYPE.INBOUND && parsed.params === accountId && !inbound) {
      inbound = { topicId, memo };
    } else if (parsed.type === HCS10_TOPIC_TYPE.OUTBOUND && !outbound) {
      outbound = { topicId, memo };
    }
  }
  return { inbound, outbound };
}

/**
 * True when a decoded registry-topic message is a `register` op for the
 * given inbound topic + account. Pure predicate — exported for tests.
 */
export function isRegisterMessageFor(
  msg: unknown,
  inboundTopicId: string,
  accountId: string,
): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    m.p === "hcs-10" &&
    m.op === "register" &&
    m.operator_id === `${inboundTopicId}@${accountId}`
  );
}

function decodeMessagePayload(base64: string): unknown | null {
  try {
    const json = Buffer.from(base64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Find topics the agent created: topic-creation transactions paid by the
 * account, then each created topic's memo. (The mirror's
 * `/api/v1/topics?account.id=` filter does not reliably return created
 * topics — verified 2026-09-15 — so we go through the account's
 * CONSENSUSCREATETOPIC history instead. Bounded: agents create few topics.)
 */
async function findAgentTopics(
  accountId: string,
  network: VerifyNetwork,
): Promise<ReturnType<typeof matchAgentTopics>> {
  const data = await fetchJson(
    `${mirrorBase(network)}/api/v1/transactions?account.id=${accountId}&transactiontype=CONSENSUSCREATETOPIC&limit=100`,
  );
  const txs = Array.isArray(data?.transactions) ? data.transactions : [];
  const seen = new Set<string>();
  const topicIds: string[] = [];
  for (const t of txs) {
    const eid = typeof t?.entity_id === "string" ? t.entity_id : "";
    if (/^0\.0\.\d+$/.test(eid) && !seen.has(eid)) {
      seen.add(eid);
      topicIds.push(eid);
    }
  }
  const rows: Array<{ topic_id: string; memo: string | null }> = [];
  for (const id of topicIds) {
    try {
      const info = await fetchJson(`${mirrorBase(network)}/api/v1/topics/${id}`);
      rows.push({
        topic_id: id,
        memo: typeof info?.memo === "string" ? info.memo : null,
      });
    } catch {
      /* an unreadable topic simply doesn't match */
    }
  }
  return matchAgentTopics(rows, accountId);
}

const REGISTRY_SCAN_LIMIT = 100;

async function checkRegistryRegistration(args: {
  inboundTopicId: string | null;
  accountId: string;
  network: VerifyNetwork;
}): Promise<RegistryCheck> {
  const registryTopicId = getHcs10RegistryTopic(args.network);
  if (!registryTopicId) {
    return {
      status: "unconfigured",
      topicId: null,
      detail:
        "no HCS-10 registry topic configured for this network (HCS10_REGISTRY_TOPIC unset) — registry check skipped, not passed",
    };
  }
  if (!args.inboundTopicId) {
    return {
      status: "not_found",
      topicId: registryTopicId,
      detail: "no inbound topic to look for — register message check impossible",
    };
  }
  const data = await fetchJson(
    `${mirrorBase(args.network)}/api/v1/topics/${registryTopicId}/messages?order=desc&limit=${REGISTRY_SCAN_LIMIT}`,
  );
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  for (const m of messages) {
    if (typeof m?.message !== "string") continue;
    const payload = decodeMessagePayload(m.message);
    if (isRegisterMessageFor(payload, args.inboundTopicId, args.accountId)) {
      return {
        status: "confirmed",
        topicId: registryTopicId,
        detail: `register op found on registry topic ${registryTopicId}`,
        evidence: {
          consensusTimestamp: String(m.consensus_timestamp ?? ""),
          sequenceNumber: String(m.sequence_number ?? ""),
        },
      };
    }
  }
  return {
    status: "not_found",
    topicId: registryTopicId,
    detail: `no register op for ${args.inboundTopicId}@${args.accountId} in the ${messages.length} most recent registry messages (scan is bounded — absence here is not proof of absence)`,
  };
}

/**
 * Resolve a Voicescape username to its Hedera account id via the agent
 * directory (owner EVM address) + mirror-node account lookup.
 */
async function resolveAccountForUsername(
  username: string,
  origin: string,
  network: VerifyNetwork,
): Promise<string> {
  const dir = await fetchJson(`${origin}/api/agents/directory`);
  const agents = Array.isArray(dir?.agents) ? dir.agents : [];
  const agent = agents.find(
    (a: any) => typeof a?.username === "string" && a.username.toLowerCase() === username.toLowerCase(),
  );
  if (!agent) {
    throw new VerifierError(404, `agent "${username}" not found in the directory`);
  }
  const owner = typeof agent.owner === "string" ? agent.owner : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) {
    throw new VerifierError(502, `agent "${username}" has no resolvable owner address`);
  }
  const acct = await fetchJson(`${mirrorBase(network)}/api/v1/accounts/${owner}`);
  const accountId = typeof acct?.account === "string" ? acct.account : "";
  if (!ACCOUNT_RE.test(accountId)) {
    throw new VerifierError(502, `could not resolve owner ${owner} to a Hedera account`);
  }
  return accountId;
}

function topicCheck(
  found: { topicId: string; memo: string } | null,
  kind: "inbound" | "outbound",
  accountId: string,
): TopicCheck {
  if (!found) {
    return {
      ok: false,
      topicId: null,
      memo: null,
      detail: `no HCS-10 ${kind} topic found for ${accountId}`,
    };
  }
  const parsed = parseHcs10TopicMemo(found.memo);
  const check: TopicCheck = {
    ok: true,
    topicId: found.topicId,
    memo: found.memo,
    detail: `HCS-10 ${kind} topic ${found.topicId} (memo "${found.memo}")`,
  };
  // The spec's memo examples use indexed=0; our pre-2026-09-15 checklist
  // told agents indexed=1. Flag it visibly instead of failing the check —
  // the topic exists and is readable either way.
  if (parsed && parsed.indexed !== 0) {
    check.note = `memo uses indexed=${parsed.indexed}; HCS-10 spec examples use indexed=0`;
  }
  return check;
}

export async function verifyAgentRegistration(args: {
  username?: string;
  accountId?: string;
  network?: VerifyNetwork;
  /** Origin of this app, e.g. https://voicescape.vercel.app — used to read our own directory for username → account resolution. */
  origin: string;
}): Promise<VerificationResult> {
  const network: VerifyNetwork = args.network === "testnet" ? "testnet" : "mainnet";
  let username: string | null = null;
  let accountId = (args.accountId ?? "").trim();
  if (args.username && args.username.trim()) {
    username = args.username.trim();
    accountId = await resolveAccountForUsername(username, args.origin, network);
  }
  if (!ACCOUNT_RE.test(accountId)) {
    throw new VerifierError(400, "provide ?username= or a valid ?accountId=0.0.x");
  }

  const { inbound, outbound } = await findAgentTopics(accountId, network);
  const inboundCheck = topicCheck(inbound, "inbound", accountId);
  const outboundCheck = topicCheck(outbound, "outbound", accountId);
  const registryCheck = await checkRegistryRegistration({
    inboundTopicId: inbound?.topicId ?? null,
    accountId,
    network,
  });

  const verified =
    inboundCheck.ok &&
    outboundCheck.ok &&
    (registryCheck.status === "confirmed" || registryCheck.status === "unconfigured");

  return {
    username,
    accountId,
    network,
    checks: {
      inboundTopic: inboundCheck,
      outboundTopic: outboundCheck,
      registryRegistration: registryCheck,
    },
    verified,
  };
}
