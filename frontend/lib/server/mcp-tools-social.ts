/**
 * MCP social tools — P1 agent social parity (Brandon: "make sure there are
 * tools equal for AI agents to do everything a human can do").
 *
 * post_forum / post_chat / create_poll / vote_poll / create_event.
 *
 * ARCHITECTURE (prepare pattern, non-custodial):
 * The town hall web handlers require a human session + a user-signed HCS
 * transaction (verifyUserHcsTx). An MCP agent has no session, so each tool
 * is a two-step flow:
 *
 *   Step 1 (prepare): call the tool WITHOUT hcs_tx_id. The tool validates
 *   everything the web handler validates (identity, boards/rooms, rate
 *   limits, content safety, restrictions), then returns { prepared: true,
 *   topic, message (the EXACT HCS JSON to submit), instructions }.
 *
 *   Step 2 (confirm): the agent signs the message with its OWN Hedera key
 *   and submits it to the topic via its own SDK call, then calls the tool
 *   again WITH hcs_tx_id. The tool verifies the tx on-chain (exists,
 *   successful, CONSENSUSSUBMITMESSAGE to the topic, paid by the agent's
 *   account, content-bound to the prepared message) via the same
 *   verifyUserHcsTx the web handlers use, then confirms posted.
 *
 * This server never holds keys and never submits anything. The agent pays
 * its own HCS fee from its own wallet for every write (no dust fee, no
 * operator key) — same as the human flow.
 *
 * SPAM GUARDS (mandatory): requireNotRestricted on the agent's wallet
 * (bans/timeouts/Copyright suspensions enforced from on-chain enforcement
 * state), per-agent daily rate limits via the KV store (workshop 20/day
 * pattern, stricter for chat), and the content safety gate (checkContent)
 * runs BEFORE anything is returned for signing — HCS is append-only, so
 * blocked content must never reach the chain.
 *
 * Naming: "polls" in the dapp are proposals (POST /api/townhall/proposals).
 * create_poll wraps proposal creation; vote_poll wraps proposal voting.
 *
 * Agent identity: every tool takes agent_username, verified on-chain as a
 * REGISTERED AGENT page (owner_type === 1) via lookup_blockpage. Fail
 * closed — an unreadable registry is not a registered agent. The HCS
 * message is authored as that username; the paying wallet must be the
 * page's on-chain owner.
 */

import { checkContent } from "./townhall/content-filter";
import { requireNotRestricted } from "./townhall/bans";
import {
  defaultDeps,
  TOWNHALL_ID_RE,
  verifyUserHcsTx,
  type HandlerResult,
  type TownhallDeps,
  queryChatRooms,
} from "./townhall/handlers";
import type { VerifiedSession } from "./townhall/auth";
import { DEFAULT_BOARDS } from "./townhall/boards";
import { isGlobalMod } from "./townhall/mod";
import { BUILDERS_ROOM_ID, BUILDER_UNLOCK_MESSAGE, hasBuilderBadge } from "./badges";
import { getTopicId } from "./townhall/topics";
import { countProposalVotes } from "./townhall/votes";
import { canonicalAddress } from "../session-message";
import { makeTownhallId } from "../townhall";
import { getKvStore, type KvStore } from "./store";
import { lookupBlockpage } from "./mcp-tools";

/** Same shape as the (non-exported) FetchFn in mcp-tools.ts. */
type FetchFn = typeof fetch;

/* ------------------------------------------------------------------ */
/* Shared deps + guards                                                */
/* ------------------------------------------------------------------ */

export interface SocialDeps {
  store?: KvStore;
  fetchFn?: FetchFn;
  /** Full townhall deps; tests inject mocks. Default: production defaults. */
  townhall?: TownhallDeps;
}

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
const DAY_MS = 24 * 3_600_000;
const MAX_BODY = 5000;

/** Per-tool daily limits (UTC day, per agent). Chat is stricter than forum. */
const RL_PREFIX = "mcp:social:rl:";
const DAILY_LIMITS = {
  post_forum: 20,
  post_chat: 10,
  create_poll: 5,
  vote_poll: 20,
  create_event: 5,
} as const;

function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().toLowerCase();
  return USERNAME_RE.test(name) ? name : null;
}

interface AgentIdentity {
  username: string;
  /** Canonical 0x owner address of the page. */
  address: string;
  /** On-chain 0.0.x owner account id. */
  accountId: string;
}

interface GuardResult {
  error?: string;
  identity?: AgentIdentity;
}

/**
 * Identity gate: agent_username must be a REGISTERED AGENT page on-chain,
 * and the caller claims the page's owner account. Returns the page owner
 * identity the agent must sign from.
 */
async function resolveAgentIdentity(
  deps: SocialDeps,
  agentUsername: unknown,
): Promise<GuardResult> {
  const username = normalizeUsername(agentUsername);
  if (!username) {
    return {
      error:
        "agent_username must be a registered blockpage username (3-32 lowercase letters, numbers, _ or -)",
    };
  }
  const fetchFn = deps.fetchFn ?? fetch;
  let lookup;
  try {
    lookup = await lookupBlockpage(username, fetchFn);
  } catch {
    return { error: `could not verify "${username}" on-chain — try again in a moment` };
  }
  if (!lookup.found || !lookup.owner_evm || !lookup.owner_account) {
    return { error: `"${username}" is not a registered blockpage yet — register one first, then use these tools` };
  }
  if (lookup.owner_type !== "agent") {
    return {
      error: `"${username}" is registered as a human page — these tools are for AI agents with registered agent blockpages`,
    };
  }
  const address = canonicalAddress(lookup.owner_evm) ?? lookup.owner_evm.toLowerCase();
  return { identity: { username, address, accountId: lookup.owner_account } };
}

/** Build the session-shaped object the townhall guards expect. */
function agentSession(identity: AgentIdentity): VerifiedSession {
  return {
    address: identity.address,
    chainId: 295,
    nonce: "",
    expiresAtMs: 0,
  } as VerifiedSession;
}

/** Restriction guard: banned / timed-out / copyright-suspended wallets are stopped before anything else. */
async function checkNotRestricted(
  th: TownhallDeps,
  identity: AgentIdentity,
): Promise<string | null> {
  const restricted = await requireNotRestricted(th, identity.address);
  if (restricted) {
    const json = restricted.json as { error?: string } | undefined;
    return json?.error ?? "wallet is restricted";
  }
  return null;
}

/** Rate limit: N/day per agent (UTC), server-side. Consumed at prepare time — a spam cannon can't re-prepare. */
async function checkRateLimit(
  store: KvStore,
  tool: keyof typeof DAILY_LIMITS,
  username: string,
): Promise<string | null> {
  const key = `${RL_PREFIX}${tool}:${username}:${utcDayKey()}`;
  const used = await store.incr(key, DAY_MS);
  if (used > DAILY_LIMITS[tool]) {
    return `daily limit reached for ${tool} (${DAILY_LIMITS[tool]}/day) — back after UTC midnight`;
  }
  return null;
}

/** Content safety gate. Mirrors the web handlers: blocked content never reaches the chain. */
function checkSafety(label: string, text: string, writeKind: string): string | null {
  const check = checkContent(text, label);
  if (!check.allowed) {
    console.warn(`[mcp-social] safety: blocked ${writeKind} — ${check.reason}`);
    return check.reason ?? "content blocked by safety filter";
  }
  return null;
}

/** Shared instructions for the prepare step. */
function prepareInstructions(
  topic: string,
  what: string,
  toolName: string,
  accountId: string,
): string {
  return (
    `STEP 2 of 2 — sign and submit yourself. This payload is UNSIGNED. Submit it as an HCS message to topic ${topic} ` +
    `with YOUR OWN Hedera key (account ${accountId} — the on-chain owner of your agent blockpage), e.g. via the Hedera SDK ` +
    `TopicMessageSubmitTransaction with the message set to the EXACT JSON above (same field names, same values — content is ` +
    `verified byte-for-byte on-chain). You pay the tiny HCS network fee from your own wallet (a few cents). Voicescape never sees ` +
    `your key. Then call the ${toolName} tool again with the same arguments PLUS hcs_tx_id (the transaction id of your ` +
    `submission, e.g. "0.0.123@1699999999.000000000") to confirm your ${what} is posted. Do NOT reuse a tx id — each one authorizes exactly one write.`
  );
}

function topicFor(domain: "forum" | "chat" | "governance"): string | { error: string } {
  const topic = getTopicId(domain);
  if (!topic) return { error: "town hall topics are not configured — try again later" };
  return topic;
}

function asError(res: { error?: string }): { error: string } {
  return { error: res.error ?? "request rejected" };
}

function verifyError(result: HandlerResult | null): { error: string } | null {
  if (result) {
    const json = result.json as { error?: string } | undefined;
    return { error: json?.error ?? `verification failed (status ${result.status})` };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Shared prepared-payload shapes                                      */
/* ------------------------------------------------------------------ */

export interface PreparedSocialWrite {
  prepared: true;
  topic: string;
  /** The exact HCS JSON to submit — content-bound, verified on-chain at confirm time. */
  message: Record<string, unknown>;
  instructions: string;
}

/* ------------------------------------------------------------------ */
/* post_forum                                                          */
/* ------------------------------------------------------------------ */

export interface PostForumArgs {
  agent_username: string;
  board?: string;
  body: string;
  reply_to?: number;
  hcs_tx_id?: string;
}

export interface ForumPostPrepared extends PreparedSocialWrite {
  board: string;
  reply_to: number | null;
}

export interface ForumPostConfirmed {
  posted: true;
  topic: string;
  tx_id: string;
  board: string;
  reply_to: number | null;
}

/**
 * Post to a town hall forum board as a registered agent.
 *
 * Step 1: call without hcs_tx_id → returns the prepared payload to sign.
 * Step 2: call again with hcs_tx_id → verifies on-chain, confirms posted.
 *
 * Boards: general, tutorials, showcase, agents, ideas, help (agent-workshop
 * posts go through post_agent_feedback; announcements is post-only for mods).
 */
export async function postForumTool(
  args: PostForumArgs,
  deps: SocialDeps = {},
): Promise<ForumPostPrepared | ForumPostConfirmed | { error: string }> {
  const store = deps.store ?? getKvStore();
  const th = deps.townhall ?? defaultDeps();

  const gate = await resolveAgentIdentity(deps, args.agent_username);
  if (!gate.identity) return asError(gate);
  const identity = gate.identity;

  const restricted = await checkNotRestricted(th, identity);
  if (restricted) return { error: restricted };

  const rl = await checkRateLimit(store, "post_forum", identity.username);
  if (rl) return { error: rl };

  const body = typeof args.body === "string" ? args.body.trim() : "";
  if (!body) return { error: "body is required" };
  if (body.length > MAX_BODY) return { error: `body too long (max ${MAX_BODY} chars)` };
  const safety = checkSafety("post body", body, "forum post");
  if (safety) return { error: safety };

  const board = typeof args.board === "string" && args.board.trim() ? args.board.trim() : "general";
  if (!DEFAULT_BOARDS.some((b) => b.id === board)) return { error: `unknown board "${board}"` };
  const boardDef = DEFAULT_BOARDS.find((b) => b.id === board)!;
  // Block the agent-workshop board (agents post via post_agent_feedback instead).
  if (board === "agent-workshop") {
    return {
      error:
        "the agent-workshop board takes reports through the post_agent_feedback tool — not through forum posts",
    };
  }
  // postOnly boards (e.g. announcements) are moderator-only.
  if (boardDef.postOnly && !isGlobalMod(identity.username, identity.address)) {
    return { error: `board "${board}" is post-only for town hall moderators` };
  }

  let replyTo: number | null = null;
  if (args.reply_to !== undefined && args.reply_to !== null) {
    if (typeof args.reply_to !== "number" || !Number.isInteger(args.reply_to) || args.reply_to <= 0) {
      return { error: "reply_to must be a post sequence number" };
    }
    replyTo = args.reply_to;
  }

  const topic = topicFor("forum");
  if (typeof topic !== "string") return topic;

  // Content-bound: the on-chain message must match these exact fields.
  const message: Record<string, unknown> = {
    v: 1,
    kind: "post",
    author: identity.username,
    board,
    wall: null,
    body,
    replyTo,
  };

  if (!args.hcs_tx_id) {
    return {
      prepared: true,
      topic,
      board,
      reply_to: replyTo,
      message,
      instructions: prepareInstructions(topic, "forum post", "post_forum", identity.accountId),
    };
  }

  const verr = verifyError(await verifyUserHcsTx(th, agentSession(identity), args.hcs_tx_id, topic, message));
  if (verr) return verr;
  return { posted: true, topic, tx_id: args.hcs_tx_id.trim(), board, reply_to: replyTo };
}

/* ------------------------------------------------------------------ */
/* post_chat                                                           */
/* ------------------------------------------------------------------ */

export interface PostChatArgs {
  agent_username: string;
  room: string;
  body: string;
  hcs_tx_id?: string;
}

export interface ChatMessagePrepared extends PreparedSocialWrite {
  room: string;
}

export interface ChatMessageConfirmed {
  posted: true;
  topic: string;
  tx_id: string;
  room: string;
}

/**
 * Send a chat message to a town hall room as a registered agent.
 *
 * Step 1: call without hcs_tx_id → returns the prepared payload to sign.
 * Step 2: call again with hcs_tx_id → verifies on-chain, confirms posted.
 *
 * The room must exist (built-in lobby/builders or a user-created room).
 * The builders room requires the Builder badge.
 */
export async function postChatTool(
  args: PostChatArgs,
  deps: SocialDeps = {},
): Promise<ChatMessagePrepared | ChatMessageConfirmed | { error: string }> {
  const store = deps.store ?? getKvStore();
  const th = deps.townhall ?? defaultDeps();

  const gate = await resolveAgentIdentity(deps, args.agent_username);
  if (!gate.identity) return asError(gate);
  const identity = gate.identity;

  const restricted = await checkNotRestricted(th, identity);
  if (restricted) return { error: restricted };

  const rl = await checkRateLimit(store, "post_chat", identity.username);
  if (rl) return { error: rl };

  const body = typeof args.body === "string" ? args.body.trim() : "";
  if (!body) return { error: "body is required" };
  if (body.length > MAX_BODY) return { error: `body too long (max ${MAX_BODY} chars)` };
  const safety = checkSafety("chat message", body, "chat message");
  if (safety) return { error: safety };

  const room = typeof args.room === "string" ? args.room.trim() : "";
  if (!room) return { error: "room is required" };
  // Room must exist.
  const roomsRes = await queryChatRooms(th);
  const roomsBody = roomsRes.json as { rooms?: Array<{ id?: string }> } | undefined;
  const rooms = Array.isArray(roomsBody?.rooms) ? roomsBody.rooms : [];
  if (!rooms.some((r) => r.id === room)) {
    return { error: `unknown chat room "${room}"` };
  }
  // Builders-only room: the signer must hold the Builder badge.
  if (room === BUILDERS_ROOM_ID) {
    const badge = await hasBuilderBadge(identity.address);
    if (!badge) return { error: BUILDER_UNLOCK_MESSAGE };
  }

  const topic = topicFor("chat");
  if (typeof topic !== "string") return topic;

  const message: Record<string, unknown> = {
    v: 1,
    kind: "chat",
    author: identity.username,
    room,
    body,
  };

  if (!args.hcs_tx_id) {
    return {
      prepared: true,
      topic,
      room,
      message,
      instructions: prepareInstructions(topic, "chat message", "post_chat", identity.accountId),
    };
  }

  const verr = verifyError(await verifyUserHcsTx(th, agentSession(identity), args.hcs_tx_id, topic, message));
  if (verr) return verr;
  return { posted: true, topic, tx_id: args.hcs_tx_id.trim(), room };
}

/* ------------------------------------------------------------------ */
/* create_poll (wraps proposals)                                       */
/* ------------------------------------------------------------------ */

export interface CreatePollArgs {
  agent_username: string;
  title: string;
  body: string;
  /** ISO-8601 date when the poll closes. */
  closes_at: string;
  /** Optional id (8-64 chars, lowercase letters/numbers/hyphens). Auto-generated when omitted. */
  poll_id?: string;
  hcs_tx_id?: string;
}

export interface PollPrepared extends PreparedSocialWrite {
  poll_id: string;
}

export interface PollConfirmed {
  posted: true;
  topic: string;
  tx_id: string;
  poll_id: string;
}

/**
 * Create a town hall poll (a proposal) as a registered agent.
 *
 * Step 1: call without hcs_tx_id → returns the prepared payload to sign
 * (includes the poll id you must embed in the message).
 * Step 2: call again with hcs_tx_id → verifies on-chain, confirms posted.
 */
export async function createPollTool(
  args: CreatePollArgs,
  deps: SocialDeps = {},
): Promise<PollPrepared | PollConfirmed | { error: string }> {
  const store = deps.store ?? getKvStore();
  const th = deps.townhall ?? defaultDeps();

  const gate = await resolveAgentIdentity(deps, args.agent_username);
  if (!gate.identity) return asError(gate);
  const identity = gate.identity;

  const restricted = await checkNotRestricted(th, identity);
  if (restricted) return { error: restricted };

  const rl = await checkRateLimit(store, "create_poll", identity.username);
  if (rl) return { error: rl };

  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return { error: "title is required" };
  const titleSafety = checkSafety("poll title", title, "poll");
  if (titleSafety) return { error: titleSafety };

  const pollBody = typeof args.body === "string" ? args.body.trim() : "";
  if (!pollBody) return { error: "body is required" };
  const bodySafety = checkSafety("poll body", pollBody, "poll");
  if (bodySafety) return { error: bodySafety };

  if (typeof args.closes_at !== "string" || Number.isNaN(Date.parse(args.closes_at))) {
    return { error: "closes_at must be an ISO-8601 date" };
  }
  const closesAt = args.closes_at;

  const id =
    typeof args.poll_id === "string" && args.poll_id.trim()
      ? args.poll_id.trim()
      : makeTownhallId(title);
  if (!TOWNHALL_ID_RE.test(id)) {
    return { error: "poll_id must be 8–64 chars, lowercase letters, numbers, and hyphens" };
  }

  const topic = topicFor("governance");
  if (typeof topic !== "string") return topic;

  const message: Record<string, unknown> = {
    v: 1,
    kind: "proposal",
    author: identity.username,
    id,
    title,
    body: pollBody,
    closesAt,
  };

  if (!args.hcs_tx_id) {
    return {
      prepared: true,
      topic,
      poll_id: id,
      message,
      instructions: prepareInstructions(topic, "poll", "create_poll", identity.accountId),
    };
  }

  const verr = verifyError(await verifyUserHcsTx(th, agentSession(identity), args.hcs_tx_id, topic, message));
  if (verr) return verr;
  return { posted: true, topic, tx_id: args.hcs_tx_id.trim(), poll_id: id };
}

/* ------------------------------------------------------------------ */
/* vote_poll (wraps proposal votes)                                    */
/* ------------------------------------------------------------------ */

export interface VotePollArgs {
  agent_username: string;
  poll_id: string;
  choice: "yes" | "no" | "abstain";
  hcs_tx_id?: string;
}

export interface VotePrepared extends PreparedSocialWrite {
  poll_id: string;
  choice: string;
}

export interface VoteConfirmed {
  voted: true;
  topic: string;
  tx_id: string;
  poll_id: string;
  choice: string;
  tally: { yes: number; no: number; abstain: number };
}

/**
 * Vote on a town hall poll (a proposal) as a registered agent.
 *
 * Step 1: call without hcs_tx_id → returns the prepared payload to sign.
 * Step 2: call again with hcs_tx_id → verifies on-chain, returns the tally.
 */
export async function votePollTool(
  args: VotePollArgs,
  deps: SocialDeps = {},
): Promise<VotePrepared | VoteConfirmed | { error: string }> {
  const store = deps.store ?? getKvStore();
  const th = deps.townhall ?? defaultDeps();

  const gate = await resolveAgentIdentity(deps, args.agent_username);
  if (!gate.identity) return asError(gate);
  const identity = gate.identity;

  const restricted = await checkNotRestricted(th, identity);
  if (restricted) return { error: restricted };

  const rl = await checkRateLimit(store, "vote_poll", identity.username);
  if (rl) return { error: rl };

  const pollId = typeof args.poll_id === "string" ? args.poll_id.trim() : "";
  if (!TOWNHALL_ID_RE.test(pollId)) return { error: "invalid poll_id" };
  if (args.choice !== "yes" && args.choice !== "no" && args.choice !== "abstain") {
    return { error: 'choice must be "yes", "no" or "abstain"' };
  }

  const topic = topicFor("governance");
  if (typeof topic !== "string") return topic;

  const message: Record<string, unknown> = {
    v: 1,
    kind: "proposal-vote",
    author: identity.username,
    proposal: pollId,
    voter: identity.username,
    choice: args.choice,
  };

  if (!args.hcs_tx_id) {
    return {
      prepared: true,
      topic,
      poll_id: pollId,
      choice: args.choice,
      message,
      instructions: prepareInstructions(topic, "poll vote", "vote_poll", identity.accountId),
    };
  }

  const verr = verifyError(await verifyUserHcsTx(th, agentSession(identity), args.hcs_tx_id, topic, message));
  if (verr) return verr;

  // Parity with the web handler: return the current tally after voting.
  const messages = await th.hcs.queryAll(topic);
  const tally = countProposalVotes(messages, pollId);
  return {
    voted: true,
    topic,
    tx_id: args.hcs_tx_id.trim(),
    poll_id: pollId,
    choice: args.choice,
    tally,
  };
}

/* ------------------------------------------------------------------ */
/* create_event                                                        */
/* ------------------------------------------------------------------ */

export interface CreateEventArgs {
  agent_username: string;
  title: string;
  description: string;
  /** ISO-8601 start date. */
  starts_at: string;
  /** Optional id (8-64 chars, lowercase letters/numbers/hyphens). Auto-generated when omitted. */
  event_id?: string;
  hcs_tx_id?: string;
}

export interface EventPrepared extends PreparedSocialWrite {
  event_id: string;
}

export interface EventConfirmed {
  posted: true;
  topic: string;
  tx_id: string;
  event_id: string;
}

/**
 * Create a town hall event as a registered agent.
 *
 * NOTE: the web handler restricts event creation to Town Hall moderators
 * (TOWNHALL_MODS usernames or TOWNHALL_MOD_WALLETS wallets) — that gate is
 * enforced here too, so non-mod agents get a clear 403-style refusal.
 *
 * Step 1: call without hcs_tx_id → returns the prepared payload to sign
 * (includes the event id you must embed in the message).
 * Step 2: call again with hcs_tx_id → verifies on-chain, confirms created.
 */
export async function createEventTool(
  args: CreateEventArgs,
  deps: SocialDeps = {},
): Promise<EventPrepared | EventConfirmed | { error: string }> {
  const store = deps.store ?? getKvStore();
  const th = deps.townhall ?? defaultDeps();

  const gate = await resolveAgentIdentity(deps, args.agent_username);
  if (!gate.identity) return asError(gate);
  const identity = gate.identity;

  // Events are moderator-only on the web — same gate for agents.
  if (!isGlobalMod(identity.username, identity.address)) {
    return {
      error:
        "only town hall moderators (TOWNHALL_MODS usernames or TOWNHALL_MOD_WALLETS wallets) may create events",
    };
  }

  const restricted = await checkNotRestricted(th, identity);
  if (restricted) return { error: restricted };

  const rl = await checkRateLimit(store, "create_event", identity.username);
  if (rl) return { error: rl };

  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return { error: "title is required" };
  const titleSafety = checkSafety("event title", title, "event");
  if (titleSafety) return { error: titleSafety };

  const description = typeof args.description === "string" ? args.description.trim() : "";
  if (!description) return { error: "description is required" };
  const descSafety = checkSafety("event description", description, "event");
  if (descSafety) return { error: descSafety };

  if (typeof args.starts_at !== "string" || Number.isNaN(Date.parse(args.starts_at))) {
    return { error: "starts_at must be an ISO-8601 date" };
  }
  const startsAt = args.starts_at;

  const id =
    typeof args.event_id === "string" && args.event_id.trim()
      ? args.event_id.trim()
      : makeTownhallId(title);
  if (!TOWNHALL_ID_RE.test(id)) {
    return { error: "event_id must be 8–64 chars, lowercase letters, numbers, and hyphens" };
  }

  const topic = topicFor("governance");
  if (typeof topic !== "string") return topic;

  const message: Record<string, unknown> = {
    v: 1,
    kind: "event",
    author: identity.username,
    id,
    title,
    description,
    startsAt,
    room: `event-${id}`,
  };

  if (!args.hcs_tx_id) {
    return {
      prepared: true,
      topic,
      event_id: id,
      message,
      instructions: prepareInstructions(topic, "event", "create_event", identity.accountId),
    };
  }

  const verr = verifyError(await verifyUserHcsTx(th, agentSession(identity), args.hcs_tx_id, topic, message));
  if (verr) return verr;
  return { posted: true, topic, tx_id: args.hcs_tx_id.trim(), event_id: id };
}
