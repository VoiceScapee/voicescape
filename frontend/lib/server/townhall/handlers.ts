/**
 * Voicescape Social Town Hall — request handlers.
 *
 * Plain async functions (no Next.js types) so they are directly unit-testable.
 * Next.js route handlers in app/api/townhall/ are thin adapters over these.
 *
 * Dependencies are injected via `TownhallDeps`; routes pass `defaultDeps()`,
 * tests pass mocks. Every POST that requires a dust fee returns
 * 402 { error, dustFeeTinybars, treasury } when the fee is missing/invalid.
 */

import { DEFAULT_BOARDS } from "./boards";
import type { HcsPort } from "./hcs";
import { defaultHcsPort } from "./hcs";
import type { MirrorPort } from "./mirror";
import { consumeDustFeeTx, defaultMirrorPort, releaseDustFeeTx, reserveDustFeeTx } from "./mirror";
import { filterHiddenPosts, isAuthorizedModAction, isGlobalMod, isModWallet } from "./mod";
import type { RegistryPort } from "./registry-check";
import { defaultRegistryPort } from "./registry-check";
import type { AuthPort, VerifiedSession } from "./auth";
import { defaultAuthPort } from "./auth";
import type { SalesPort } from "./sales";
import { defaultSalesPort } from "./sales";
import { canonicalAddress } from "../../session-message";
import { globalQuotaStore, quotaExceededBody, quotaLimitFromEnv } from "../quota";
import { getTopicId, type TopicDomain } from "./topics";
import { checkContent } from "./content-filter";
import type {
  ChatEvent,
  ChatMessage,
  ChatRoom,
  ChatRoomMessage,
  EventMessage,
  EventView,
  ListingMessage,
  ListingView,
  ModActionMessage,
  PostMessage,
  PostView,
  ProposalMessage,
  ProposalView,
  ProposalVoteMessage,
  ReportMessage,
  ReportView,
  RepVoteMessage,
  ReputationView,
  StoredMessage,
} from "./types";
import {
  aggregateListings,
  aggregateRepVotes,
  collectPosts,
  collectProposals,
  countProposalVotes,
  orderNewestFirst,
} from "./votes";

export interface TownhallDeps {
  hcs: HcsPort;
  mirror: MirrorPort;
  registry: RegistryPort;
  auth: AuthPort;
  sales: SalesPort;
}

// Re-exported for the chat SSE route adapter.
export type { ChatEvent };

export function defaultDeps(): TownhallDeps {
  return {
    hcs: defaultHcsPort(),
    mirror: defaultMirrorPort(),
    registry: defaultRegistryPort(),
    auth: defaultAuthPort(),
    sales: defaultSalesPort(),
  };
}

export interface HandlerResult {
  status: number;
  json: unknown;
}

function ok(json: unknown, status = 200): HandlerResult {
  return { status, json };
}

function err(status: number, error: string, extra: Record<string, unknown> = {}): HandlerResult {
  return { status, json: { error, ...extra } };
}

/* ------------------------------------------------------------------ */
/* Shared guards                                                      */
/* ------------------------------------------------------------------ */

function topicOr503(domain: TopicDomain): HandlerResult | string {
  const id = getTopicId(domain);
  if (!id) return err(503, `Town Hall topic for "${domain}" is not configured`);
  return id;
}

/**
 * Pre-publish safety gate. Runs checkContent() on user-supplied text BEFORE
 * any HCS submit — HCS is append-only and immutable, so blocked content must
 * never reach the chain. Returns an err() result when blocked, null when
 * clean. Blocked attempts are logged with the category only (no offending
 * text, no author identity).
 */
function safetyGate(label: string, text: string, writeKind: string): HandlerResult | null {
  const check = checkContent(text, label);
  if (!check.allowed) {
    console.warn(`[townhall] safety: blocked ${writeKind} — ${check.reason}`);
    return err(400, check.reason ?? "content blocked by safety filter");
  }
  return null;
}

/**
 * The operator's key pays the HCS TopicMessageSubmit fee for every town
 * hall write (~$0.0001/message ≈ 50k tinybars at $0.20/HBAR; the default
 * here is a conservative 2x of that). Configurable via
 * HCS_SUBMIT_FEE_TINYBARS for when network pricing moves. Read per request
 * so it is serverless-safe.
 */
function operatorSubmitCostTinybars(): number {
  const raw = process.env.HCS_SUBMIT_FEE_TINYBARS;
  if (raw && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return 100_000;
}

async function requireDustFee(
  deps: TownhallDeps,
  session: VerifiedSession,
  dustFeeTxId: unknown,
): Promise<HandlerResult | null> {
  const { dustFeeTinybars, treasury } = deps.mirror.feeInfo();
  // Economics guard BEFORE fee verification: the dust fee goes to the
  // treasury while the OPERATOR's key pays the HCS submit fee. They are
  // enforced as separate accounts (conservative: if they're the same
  // pocket the platform still never loses). A zero or below-cost fee
  // passes nothing and the operator would still pay the submit — so
  // misconfiguration fails LOUD (503), never silently.
  const costFloor = operatorSubmitCostTinybars() * 2;
  if (dustFeeTinybars === 0) {
    console.error(
      "[townhall] ECONOMICS: DUST_FEE_TINYBARS is 0 — town hall writes DISABLED. " +
        "The operator's key would pay every HCS submit fee out of pocket.",
    );
    return err(
      503,
      "town hall writes are disabled: dust fee is not configured — the operator cannot subsidize writes",
      { dustFeeTinybars, treasury },
    );
  }
  if (dustFeeTinybars < costFloor) {
    console.error(
      `[townhall] ECONOMICS: dust fee ${dustFeeTinybars} tinybars is below the operator ` +
        `cost floor ${costFloor} tinybars — town hall writes DISABLED. Raise DUST_FEE_TINYBARS.`,
    );
    return err(
      503,
      `dust fee (${dustFeeTinybars} tinybars) is below the operator cost floor (${costFloor} tinybars) — raise DUST_FEE_TINYBARS`,
      { dustFeeTinybars, treasury },
    );
  }
  if (!dustFeeTxId || typeof dustFeeTxId !== "string") {
    return err(402, "dust fee required: send a small HBAR transfer to the treasury first", {
      dustFeeTinybars,
      treasury,
    });
  }
  // Normalize: the same payment must not look like two different tx ids
  // just because of surrounding whitespace.
  const feeTxId = dustFeeTxId.trim();
  if (!feeTxId) {
    return err(402, "dust fee required: send a small HBAR transfer to the treasury first", {
      dustFeeTinybars,
      treasury,
    });
  }
  // Replay protection: one fee payment buys exactly one write. The tx id
  // is RESERVED atomically here — before the awaited verification —
  // so two concurrent requests presenting the same tx id cannot both
  // pass: the second sees the reservation and is rejected. The
  // reservation is released if verification fails (the fee stays
  // retryable) and becomes a permanent consumed record on success.
  // The store's SET … NX makes this atomic across instances too.
  let reserved: boolean;
  try {
    reserved = await reserveDustFeeTx(feeTxId);
  } catch (e) {
    // The replay store is unreachable: fail CLOSED (503), never treat an
    // unchecked fee as valid.
    console.error(`[townhall] replay store unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return err(503, "temporarily unavailable — please retry in a moment", { dustFeeTinybars, treasury });
  }
  if (!reserved) {
    return err(402, "dust fee already used: each fee payment covers a single write — pay a fresh fee", {
      dustFeeTinybars,
      treasury,
    });
  }
  // Sender binding: the fee must have been paid by the wallet that signed
  // the session. verifyDustFee resolves 0x… sessions to their 0.0.x
  // account id via the mirror node before comparing to the tx's payer.
  let res;
  try {
    res = await deps.mirror.verifyDustFee(feeTxId, session.address);
  } catch {
    await releaseDustFeeTx(feeTxId).catch(() => {});
    return err(502, "dust fee verification failed — try again", { dustFeeTinybars, treasury });
  }
  if (!res.ok) {
    await releaseDustFeeTx(feeTxId).catch(() => {});
    return err(402, `dust fee invalid: ${res.reason}`, { dustFeeTinybars, treasury });
  }
  try {
    await consumeDustFeeTx(feeTxId);
  } catch (e) {
    // The fee verified but could not be recorded as consumed: fail CLOSED
    // (503) rather than risk the same fee paying for a second write.
    console.error(`[townhall] replay store unreachable on consume: ${e instanceof Error ? e.message : String(e)}`);
    return err(503, "temporarily unavailable — please retry in a moment", { dustFeeTinybars, treasury });
  }
  return null;
}

/**
 * Every write body carries the session credential decoded from the
 * `x-vs-session` header by the route adapter.
 */
export interface AuthBody {
  auth?: unknown;
}

type SessionCheck = { ok: true; session: VerifiedSession } | { ok: false; result: HandlerResult };

/** Verify the signed wallet session. 401 when missing/invalid/expired. */
async function requireSession(deps: TownhallDeps, body: AuthBody): Promise<SessionCheck> {
  const res = await deps.auth.verifySession(body?.auth);
  if (!res.ok) return { ok: false, result: err(401, res.error) };
  return { ok: true, session: res.session };
}

type OwnerCheck =
  | { ok: true; username: string; session: VerifiedSession }
  | { ok: false; result: HandlerResult };

/**
 * Verify the session AND bind the claimed username to it: the username must
 * resolve on-chain to the session's address. Authorship is cryptographic,
 * not self-asserted — a valid signature from any other wallet is rejected.
 */
async function requirePageOwner(
  deps: TownhallDeps,
  body: AuthBody,
  username: unknown,
  field = "author",
): Promise<OwnerCheck> {
  const s = await requireSession(deps, body);
  if (!s.ok) return s;
  if (!username || typeof username !== "string" || !username.trim()) {
    return { ok: false, result: err(400, `${field} is required`) };
  }
  const name = username.trim();
  let owner: string | null;
  try {
    owner = await deps.registry.resolveOwner(name);
  } catch {
    return { ok: false, result: err(503, "registry unavailable — try again in a moment") };
  }
  if (!owner) {
    return { ok: false, result: err(403, `username "${name}" is not registered in the Voicescape registry`) };
  }
  const ownerCanonical = canonicalAddress(owner);
  if (!ownerCanonical || ownerCanonical !== s.session.address) {
    return {
      ok: false,
      result: err(403, `this wallet does not own the "${name}" page — sign in with the page owner's wallet`),
    };
  }
  return { ok: true, username: name, session: s.session };
}

type ActorCheck =
  | { ok: true; name: string; session: VerifiedSession; walletMod: boolean }
  | { ok: false; result: HandlerResult };

/**
 * Resolve the acting identity for mod-privileged writes. A session wallet
 * listed in TOWNHALL_MOD_WALLETS acts as a global mod with no page
 * registration required; everyone else must own the claimed page via
 * requirePageOwner. When a mod wallet also owns the claimed page, the page
 * username is used for nicer authorship and the wallet is still recorded
 * on mod-actions (modWallet) so the session-less read path honors them.
 */
async function requireModActor(
  deps: TownhallDeps,
  body: AuthBody,
  username: unknown,
  field = "author",
): Promise<ActorCheck> {
  const s = await requireSession(deps, body);
  if (!s.ok) return s;
  const walletMod = isModWallet(s.session.address);
  const own = await requirePageOwner(deps, body, username, field);
  if (own.ok) return { ok: true, name: own.username, session: own.session, walletMod };
  if (walletMod) {
    return { ok: true, name: s.session.address, session: s.session, walletMod: true };
  }
  return own;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/* ------------------------------------------------------------------ */
/* Free-write quota (fee-free handlers)                                */
/* ------------------------------------------------------------------ */

/**
 * Per-wallet daily quota for town-hall writes that do NOT require a dust
 * fee (proposal votes, reputation votes, listing status changes, mod
 * actions, events). Each of these costs the operator an HCS submit fee
 * (~$0.0001) with no fee collected, so an unbounded free path lets a
 * spammer drain the operator account — and a drained operator account
 * breaks ALL town-hall writes. Voting stays free for real humans: the
 * default 50/day is far above legitimate use; beyond that the route
 * answers 429 until the next UTC midnight. Tunable via
 * TOWNHALL_WRITE_DAILY_QUOTA (0 = deny all). The store's atomic INCR means
 * concurrent requests cannot double-spend one unit of quota, across
 * instances too.
 */
const TOWNHALL_WRITE_QUOTA_BUCKET = "townhall:free-writes";

function townhallWriteQuotaLimit(): number {
  return quotaLimitFromEnv("TOWNHALL_WRITE_DAILY_QUOTA", 50);
}

/** 429 when the wallet exhausted its daily free-write quota; null when OK. Consumes one unit. */
async function requireTownhallWriteQuota(session: VerifiedSession): Promise<HandlerResult | null> {
  const limit = townhallWriteQuotaLimit();
  let res;
  try {
    res = await globalQuotaStore().consume(
      TOWNHALL_WRITE_QUOTA_BUCKET,
      session.address.toLowerCase(),
      limit,
    );
  } catch (e) {
    // Quota store unreachable: fail CLOSED (503) — an unchecked free
    // write could drain the operator account.
    console.error(`[townhall] quota store unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return err(503, "temporarily unavailable — please retry in a moment");
  }
  if (!res.allowed) {
    return {
      status: 429,
      json: quotaExceededBody(res, "daily town hall write quota exceeded — try again after UTC midnight"),
    };
  }
  return null;
}

/** URL-safe slug + short random suffix, so ids are unique. */
export function makeId(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "item";
  return `${slug}-${Date.now().toString(36)}`;
}

const MAX_BODY = 5000;

/* ------------------------------------------------------------------ */
/* Boards                                                             */
/* ------------------------------------------------------------------ */

export function getBoards(): HandlerResult {
  return ok({
    boards: DEFAULT_BOARDS.map(({ id, title, description }) => ({ id, title, description })),
  });
}

/* ------------------------------------------------------------------ */
/* Posts                                                              */
/* ------------------------------------------------------------------ */

export interface GetPostsQuery {
  board?: string;
  wall?: string;
  limit?: string;
  before?: string;
}

export async function getPosts(deps: TownhallDeps, q: GetPostsQuery): Promise<HandlerResult> {
  const topic = topicOr503("forum");
  if (typeof topic !== "string") return topic;
  const messages = await deps.hcs.queryAll(topic);
  const posts = collectPosts(messages);
  const mods: StoredMessage<ModActionMessage>[] = messages.filter(
    (m): m is StoredMessage<ModActionMessage> => m.contents.kind === "mod-action",
  );
  const visible = filterHiddenPosts(
    posts.map((p) => ({ ...p, board: p.contents.board, wall: p.contents.wall })),
    mods.map((m) => m.contents),
  );
  let filtered = visible;
  if (q.board) filtered = filtered.filter((p) => p.board.toLowerCase() === q.board!.toLowerCase());
  if (q.wall) filtered = filtered.filter((p) => p.wall && p.wall.toLowerCase() === q.wall!.toLowerCase());
  const ordered = orderNewestFirst(filtered);
  const before = q.before ? Number(q.before) : NaN;
  const afterBefore = Number.isFinite(before) ? ordered.filter((p) => p.seq < before) : ordered;
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
  const page = afterBefore.slice(0, limit);
  const views: PostView[] = page.map((p) => ({
    seq: p.seq,
    board: p.contents.board,
    wall: p.contents.wall,
    author: p.contents.author,
    body: p.contents.body,
    replyTo: p.contents.replyTo,
    ts: p.contents.ts,
  }));
  return ok({ posts: views });
}

export interface CreatePostBody extends AuthBody {
  board?: unknown;
  wall?: unknown;
  body?: unknown;
  replyTo?: unknown;
  dustFeeTxId?: unknown;
  author?: unknown;
}

export async function createPost(deps: TownhallDeps, body: CreatePostBody): Promise<HandlerResult> {
  const actor = await requireModActor(deps, body, body.author);
  if (!actor.ok) return actor.result;
  const author = actor.name;
  if (!isNonEmptyString(body.body)) return err(400, "body is required");
  if (body.body.length > MAX_BODY) return err(400, `body too long (max ${MAX_BODY} chars)`);
  const board = typeof body.board === "string" && body.board.trim() ? body.board.trim() : "general";
  if (!DEFAULT_BOARDS.some((b) => b.id === board)) return err(400, `unknown board "${board}"`);  const boardDef = DEFAULT_BOARDS.find((b) => b.id === board)!;
  if (boardDef.postOnly && !isGlobalMod(author, actor.session.address)) {
    return err(403, `board "${board}" is post-only for moderators`);
  }
  const wall = typeof body.wall === "string" && body.wall.trim() ? body.wall.trim() : null;
  if (wall) {
    const wallRegistered = await deps.registry.isRegistered(wall);
    if (!wallRegistered) return err(400, `wall owner "${wall}" is not registered`);
  }
  let replyTo: number | null = null;
  if (body.replyTo !== undefined && body.replyTo !== null) {
    if (typeof body.replyTo !== "number" || !Number.isInteger(body.replyTo) || body.replyTo <= 0) {
      return err(400, "replyTo must be a post sequence number");
    }
    replyTo = body.replyTo;
  }
  const gate = safetyGate("post body", body.body, "forum post");
  if (gate) return gate;
  const fee = await requireDustFee(deps, actor.session, body.dustFeeTxId);
  if (fee) return fee;
  const topic = topicOr503("forum");
  if (typeof topic !== "string") return topic;
  const msg: PostMessage = {
    v: 1,
    kind: "post",
    ts: new Date().toISOString(),
    author,
    board,
    wall,
    body: body.body,
    replyTo,
  };
  const seq = await deps.hcs.submit(topic, msg);
  return ok({ seq }, 201);
}

/* ------------------------------------------------------------------ */
/* Chat rooms                                                         */
/* ------------------------------------------------------------------ */

/** The built-in room, always listed first. */
export const LOBBY_ROOM: ChatRoom = {
  id: "lobby",
  title: "🏠 Lobby",
  description: "The always-open town square. Say hi.",
  creator: "voicescape",
  createdAt: "",
};

/** URL-safe room slug: 3–32 chars, lowercase letters, numbers, hyphens. */
export const CHATROOM_ID_RE = /^[a-z0-9-]{3,32}$/;

/** Read custom rooms from the chat topic (kind="chatroom-create"). */
async function collectChatRooms(deps: TownhallDeps): Promise<ChatRoom[]> {
  const topic = getTopicId("chat");
  if (!topic) return [];
  const messages = await deps.hcs.queryAll(topic);
  const rooms: ChatRoom[] = [];
  for (const m of messages) {
    if (m.contents.kind !== "chatroom-create") continue;
    const c = m.contents as ChatRoomMessage;
    rooms.push({
      id: c.id,
      title: c.title,
      description: c.description,
      creator: c.author,
      createdAt: c.ts,
    });
  }
  rooms.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return rooms;
}

/**
 * List chatrooms: the built-in lobby first, then user/agent-created rooms
 * from the chat topic. Session-less read.
 */
export async function queryChatRooms(deps: TownhallDeps): Promise<HandlerResult> {
  const topic = topicOr503("chat");
  if (typeof topic !== "string") return topic;
  const rooms = await collectChatRooms(deps);
  return ok({ rooms: [LOBBY_ROOM, ...rooms] });
}

export interface CreateChatRoomBody extends AuthBody {
  author?: unknown;
  /** URL slug, 3–32 chars, [a-z0-9-]. The client derives it from the title. */
  id?: unknown;
  title?: unknown;
  description?: unknown;
  dustFeeTxId?: unknown;
}

export async function createChatRoom(deps: TownhallDeps, body: CreateChatRoomBody): Promise<HandlerResult> {
  const own = await requirePageOwner(deps, body, body.author);
  if (!own.ok) return own.result;
  const author = own.username;
  if (!isNonEmptyString(body.id) || !CHATROOM_ID_RE.test(body.id)) {
    return err(400, "id must be a slug: 3–32 chars, lowercase letters, numbers, and hyphens");
  }
  const id = body.id;
  if (id === "lobby") return err(400, 'id "lobby" is reserved');
  if (!isNonEmptyString(body.title)) return err(400, "title is required");
  const title = body.title.trim();
  if (title.length < 3 || title.length > 60) return err(400, "title must be 3–60 chars");
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (description.length > 200) return err(400, "description too long (max 200 chars)");
  const gateTitle = safetyGate("room title", title, "chatroom");
  if (gateTitle) return gateTitle;
  if (description) {
    const gateDesc = safetyGate("room description", description, "chatroom");
    if (gateDesc) return gateDesc;
  }
  const fee = await requireDustFee(deps, own.session, body.dustFeeTxId);
  if (fee) return fee;
  const topic = topicOr503("chat");
  if (typeof topic !== "string") return topic;
  // First create wins — an id that already exists is a conflict.
  const existing = await collectChatRooms(deps);
  if (existing.some((r) => r.id === id)) return err(409, `room "${id}" already exists`);
  const msg: ChatRoomMessage = {
    v: 1,
    kind: "chatroom-create",
    ts: new Date().toISOString(),
    author,
    id,
    title,
    description,
  };
  await deps.hcs.submit(topic, msg);
  return ok({ roomId: id }, 201);
}

/* ------------------------------------------------------------------ */
/* Reputation                                                         */
/* ------------------------------------------------------------------ */

export async function getReputation(
  deps: TownhallDeps,
  target: string | undefined,
  voter: string | undefined,
): Promise<HandlerResult> {
  if (!isNonEmptyString(target)) return err(400, "target is required");
  const topic = topicOr503("votes");
  if (typeof topic !== "string") return topic;
  const messages = await deps.hcs.queryAll(topic);
  const tally = aggregateRepVotes(messages, target, voter);
  const view: ReputationView = { target, up: tally.up, down: tally.down, score: tally.score, myVote: tally.myVote };
  return ok(view);
}

export interface CastRepVoteBody extends AuthBody {
  target?: unknown;
  voter?: unknown;
  value?: unknown;
}

export async function castRepVote(deps: TownhallDeps, body: CastRepVoteBody): Promise<HandlerResult> {
  if (!isNonEmptyString(body.target)) return err(400, "target is required");
  const own = await requirePageOwner(deps, body, body.voter, "voter");
  if (!own.ok) return own.result;
  const voter = own.username;
  const target = (body.target as string).trim();
  if (voter.toLowerCase() === target.toLowerCase()) return err(400, "cannot vote for yourself");
  if (body.value !== 1 && body.value !== -1) return err(400, "value must be 1 or -1");
  // Proof-of-payment: the voter's wallet must have ≥1 COMPLETED on-chain
  // purchase from the target page's owner (an atomic buyListing sale —
  // no escrow; the PurchaseCompleted event is the proof). Both parties
  // resolve to canonical 0x addresses and the Tips contract is the
  // source of truth — see SalesPort.
  let targetOwner: string | null;
  try {
    targetOwner = await deps.registry.resolveOwner(target);
  } catch {
    return err(503, "registry unavailable — try again in a moment");
  }
  const seller = targetOwner ? canonicalAddress(targetOwner) : null;
  if (!seller) {
    return err(403, `cannot vote for "${target}": the page is not registered, so proof-of-payment cannot be checked`);
  }
  let eligible: boolean;
  try {
    eligible = await deps.sales.hasCompletedPurchase(own.session.address, seller);
  } catch {
    return err(503, "could not verify purchase history — try again in a moment");
  }
  if (!eligible) {
    return err(
      403,
      "reputation votes are proof-of-payment: only wallets with a completed on-chain purchase from this page's owner can vote",
    );
  }
  const topic = topicOr503("votes");
  if (typeof topic !== "string") return topic;
  // Free path (no dust fee): bound operator-subsidized writes per wallet.
  const quota = await requireTownhallWriteQuota(own.session);
  if (quota) return quota;
  const msg: RepVoteMessage = {
    v: 1,
    kind: "rep-vote",
    ts: new Date().toISOString(),
    author: voter,
    target,
    voter,
    value: body.value,
  };
  await deps.hcs.submit(topic, msg);
  const messages = await deps.hcs.queryAll(topic);
  const tally = aggregateRepVotes(messages, target, voter);
  return ok({ up: tally.up, down: tally.down, score: tally.score, myVote: tally.myVote });
}

/* ------------------------------------------------------------------ */
/* Proposals (UI: "Polls" — advisory, no execution)                   */
/*                                                                    */
/* The internal topic domain key stays "governance" for env-compat    */
/* (see topics.ts); HCS wire kinds are "proposal"/"proposal-vote".    */
/* ------------------------------------------------------------------ */

export async function getProposals(deps: TownhallDeps): Promise<HandlerResult> {
  const topic = topicOr503("governance");
  if (typeof topic !== "string") return topic;
  const messages = await deps.hcs.queryAll(topic);
  const proposals = orderNewestFirst(collectProposals(messages));
  const views: ProposalView[] = proposals.map((p) => {
    const tally = countProposalVotes(messages, p.contents.id);
    return {
      id: p.contents.id,
      author: p.contents.author,
      title: p.contents.title,
      body: p.contents.body,
      closesAt: p.contents.closesAt,
      ...tally,
    };
  });
  return ok({ proposals: views });
}

export interface CreateProposalBody extends AuthBody {
  author?: unknown;
  title?: unknown;
  body?: unknown;
  closesAt?: unknown;
  dustFeeTxId?: unknown;
}

export async function createProposal(deps: TownhallDeps, body: CreateProposalBody): Promise<HandlerResult> {
  const own = await requirePageOwner(deps, body, body.author);
  if (!own.ok) return own.result;
  const author = own.username;
  if (!isNonEmptyString(body.title)) return err(400, "title is required");
  if (!isNonEmptyString(body.body)) return err(400, "body is required");
  if (!isNonEmptyString(body.closesAt) || Number.isNaN(Date.parse(body.closesAt))) {
    return err(400, "closesAt must be an ISO-8601 date");
  }
  const fee = await requireDustFee(deps, own.session, body.dustFeeTxId);
  if (fee) return fee;
  const topic = topicOr503("governance");
  if (typeof topic !== "string") return topic;
  const id = makeId(body.title);
  const msg: ProposalMessage = {
    v: 1,
    kind: "proposal",
    ts: new Date().toISOString(),
    author,
    id,
    title: body.title.trim(),
    body: body.body,
    closesAt: new Date(body.closesAt).toISOString(),
  };
  await deps.hcs.submit(topic, msg);
  return ok({ id }, 201);
}

export interface VoteProposalBody extends AuthBody {
  voter?: unknown;
  choice?: unknown;
}

export async function voteProposal(
  deps: TownhallDeps,
  proposalId: string,
  body: VoteProposalBody,
): Promise<HandlerResult> {
  const own = await requirePageOwner(deps, body, body.voter, "voter");
  if (!own.ok) return own.result;
  const voter = own.username;
  if (body.choice !== "yes" && body.choice !== "no" && body.choice !== "abstain") {
    return err(400, 'choice must be "yes", "no" or "abstain"');
  }
  const topic = topicOr503("governance");
  if (typeof topic !== "string") return topic;
  // Free path (no dust fee): bound operator-subsidized writes per wallet.
  const quota = await requireTownhallWriteQuota(own.session);
  if (quota) return quota;
  const msg: ProposalVoteMessage = {
    v: 1,
    kind: "proposal-vote",
    ts: new Date().toISOString(),
    author: voter,
    proposal: proposalId,
    voter,
    choice: body.choice,
  };
  await deps.hcs.submit(topic, msg);
  const messages = await deps.hcs.queryAll(topic);
  const tally = countProposalVotes(messages, proposalId);
  return ok(tally);
}

/* ------------------------------------------------------------------ */
/* Chat                                                               */
/* ------------------------------------------------------------------ */

export async function queryChatMessages(
  deps: TownhallDeps,
  room: string,
  afterSeq = 0,
): Promise<ChatEvent[]> {
  const topic = getTopicId("chat");
  if (!topic) return [];
  const messages = await deps.hcs.query(topic, { afterSeq, limit: 100 });
  const events: ChatEvent[] = [];
  const modActions: ModActionMessage[] = [];
  for (const m of messages) {
    if (m.contents.kind === "chat") {
      const c = m.contents as ChatMessage;
      if (c.room !== room) continue;
      events.push({ seq: m.seq, room: c.room, author: c.author, body: c.body, ts: c.ts });
    } else if (m.contents.kind === "mod-action") {
      modActions.push(m.contents as ModActionMessage);
    }
  }
  if (modActions.length === 0) return events;
  // Mod-hides apply to chat as well as forum posts. Chat messages carry
  // `room` instead of `board`/`wall`, so room is mapped onto the board
  // slot; hides submitted for forum posts (targetKind "post") never match.
  const visible = filterHiddenPosts(
    events.map((e) => ({ ...e, board: e.room, wall: null as string | null })),
    modActions,
    "chat",
  );
  const visibleSeqs = new Set(visible.map((v) => v.seq));
  return events.filter((e) => visibleSeqs.has(e.seq));
}

export interface PostChatBody extends AuthBody {
  author?: unknown;
  body?: unknown;
  dustFeeTxId?: unknown;
}

export async function postChat(deps: TownhallDeps, room: string, body: PostChatBody): Promise<HandlerResult> {
  const own = await requirePageOwner(deps, body, body.author);
  if (!own.ok) return own.result;
  const author = own.username;
  if (!isNonEmptyString(body.body)) return err(400, "body is required");
  if (body.body.length > MAX_BODY) return err(400, `body too long (max ${MAX_BODY} chars)`);
  const gate = safetyGate("chat message", body.body, "chat message");
  if (gate) return gate;
  const fee = await requireDustFee(deps, own.session, body.dustFeeTxId);
  if (fee) return fee;
  const topic = topicOr503("chat");
  if (typeof topic !== "string") return topic;
  const msg: ChatMessage = {
    v: 1,
    kind: "chat",
    ts: new Date().toISOString(),
    author,
    room,
    body: body.body,
  };
  const seq = await deps.hcs.submit(topic, msg);
  return ok({ seq }, 201);
}

/* ------------------------------------------------------------------ */
/* Moderation                                                         */
/* ------------------------------------------------------------------ */

export interface SubmitModActionBody extends AuthBody {
  author?: unknown;
  /** "post" (forum) or "chat" (chat message). Defaults to "post". */
  targetKind?: unknown;
  /** HCS sequence number of the message to hide. */
  targetSeq?: unknown;
  /** Post → board name; chat → room name. null = global scope. */
  board?: unknown;
  wall?: unknown;
}

/**
 * Submit a mod-action (hide). Gated by session + page ownership (or mod-wallet
 * session alone), then by mod.ts authorization: global/board mods
 * (TOWNHALL_MODS usernames or TOWNHALL_MOD_WALLETS wallets) may hide
 * anywhere; a page owner may hide posts on their own wall. The action is
 * appended to the same HCS topic as its target, so the existing read paths
 * (getPosts for forum, queryChatMessages for chat) pick it up. No dust fee:
 * moderation is a service, not a write to tax.
 */
export async function submitModAction(
  deps: TownhallDeps,
  body: SubmitModActionBody,
): Promise<HandlerResult> {
  const actor = await requireModActor(deps, body, body.author);
  if (!actor.ok) return actor.result;
  const moderator = actor.name;

  const targetKind = body.targetKind === "chat" ? "chat" : "post";
  if (typeof body.targetSeq !== "number" || !Number.isInteger(body.targetSeq) || body.targetSeq <= 0) {
    return err(400, "targetSeq must be a positive integer: the HCS sequence number of the message to hide");
  }
  const targetSeq = body.targetSeq;
  const board = typeof body.board === "string" && body.board.trim() ? body.board.trim() : null;
  const wall = typeof body.wall === "string" && body.wall.trim() ? body.wall.trim() : null;

  const msg: ModActionMessage = {
    v: 1,
    kind: "mod-action",
    ts: new Date().toISOString(),
    author: moderator,
    targetKind,
    board,
    wall,
    targetSeq,
    action: "hide",
    // Wallet-mods acting under a username still record their wallet so the
    // session-less read path (hiddenSeqs) honors the hide.
    modWallet: actor.walletMod ? actor.session.address : null,
  };
  if (!isAuthorizedModAction(msg)) {
    return err(
      403,
      "not authorized to moderate here: global mods (TOWNHALL_MODS usernames or TOWNHALL_MOD_WALLETS wallets) may hide anywhere; page owners may hide posts on their own wall",
    );
  }

  // The target must exist in the domain's topic.
  const domain: TopicDomain = targetKind === "chat" ? "chat" : "forum";
  const topic = topicOr503(domain);
  if (typeof topic !== "string") return topic;
  const wantKind = targetKind === "chat" ? "chat" : "post";
  const messages = await deps.hcs.queryAll(topic);
  const found = messages.some((m) => m.seq === targetSeq && m.contents.kind === wantKind);
  if (!found) {
    return err(404, `${targetKind === "chat" ? "chat message" : "post"} #${targetSeq} not found`);
  }

  // Free path (no dust fee): bound operator-subsidized writes per wallet.
  // Checked after all validation, before the operator-paid HCS submit.
  const quota = await requireTownhallWriteQuota(actor.session);
  if (quota) return quota;
  const seq = await deps.hcs.submit(topic, msg);
  return ok({ seq }, 201);
}

/* ------------------------------------------------------------------ */
/* User safety reports                                                */
/* ------------------------------------------------------------------ */

export interface SubmitReportBody extends AuthBody {
  reporter?: unknown;
  /** "post" (forum) | "chat" (chat message) | "listing" (marketplace). */
  targetKind?: unknown;
  /** HCS sequence number of the target (post/chat targets). */
  targetSeq?: unknown;
  /** Listing id (listing targets). */
  targetId?: unknown;
  /** Reporter's explanation, 10–500 chars. */
  reason?: unknown;
}

type ReportTargetKind = "post" | "chat" | "listing";

function reportTopicDomain(kind: ReportTargetKind): TopicDomain {
  return kind === "chat" ? "chat" : kind === "listing" ? "market" : "forum";
}

/**
 * File a safety report against a post, chat message, or listing.
 *
 * Auth: signed wallet session only — no page ownership required and no
 * dust fee, so reporting stays free and frictionless. The report is
 * appended as kind "report" to the SAME HCS topic as its target, so
 * moderators can correlate reports with targets in a single read.
 *
 * The reason is deliberately NOT run through the content filter: a
 * reporter describing violating content must not be blocked for quoting
 * it. Reports are only visible to moderators via queryReports.
 *
 * 201 → {seq} of the report message. Errors: 400 bad input, 401 no
 * session, 404 target not found, 429 daily report quota exceeded.
 */
export async function submitReport(deps: TownhallDeps, body: SubmitReportBody): Promise<HandlerResult> {
  const s = await requireSession(deps, body);
  if (!s.ok) return s.result;
  const targetKind = body.targetKind;
  if (targetKind !== "post" && targetKind !== "chat" && targetKind !== "listing") {
    return err(400, 'targetKind must be "post", "chat", or "listing"');
  }
  // Reporter identity: the registered username when it resolves to the
  // signing wallet, otherwise the canonical wallet address.
  let reporter = s.session.address;
  if (typeof body.reporter === "string" && body.reporter.trim()) {
    const name = body.reporter.trim();
    try {
      const owner = await deps.registry.resolveOwner(name);
      if (owner && canonicalAddress(owner) === s.session.address) reporter = name;
    } catch {
      // Registry hiccup — fall back to the wallet address.
    }
  }
  if (typeof body.reason !== "string" || body.reason.trim().length < 10) {
    return err(400, "reason must be at least 10 characters");
  }
  const reason = body.reason.trim();
  if (reason.length > 500) return err(400, "reason too long (max 500 chars)");

  const domain = reportTopicDomain(targetKind);
  const topic = topicOr503(domain);
  if (typeof topic !== "string") return topic;

  // The target must exist.
  const messages = await deps.hcs.queryAll(topic);
  let targetSeq: number | null = null;
  let targetId: string | null = null;
  if (targetKind === "listing") {
    if (typeof body.targetId !== "string" || !body.targetId.trim()) {
      return err(400, "targetId is required for listing reports");
    }
    targetId = body.targetId.trim();
    if (!aggregateListings(messages).has(targetId)) {
      return err(404, `listing "${targetId}" not found`);
    }
  } else {
    if (typeof body.targetSeq !== "number" || !Number.isInteger(body.targetSeq) || body.targetSeq <= 0) {
      return err(400, "targetSeq must be a positive integer: the HCS sequence number of the reported message");
    }
    targetSeq = body.targetSeq;
    const wantKind = targetKind === "chat" ? "chat" : "post";
    const found = messages.some((m) => m.seq === targetSeq && m.contents.kind === wantKind);
    if (!found) {
      return err(404, `${targetKind === "chat" ? "chat message" : "post"} #${targetSeq} not found`);
    }
  }

  const msg: ReportMessage = {
    v: 1,
    kind: "report",
    ts: new Date().toISOString(),
    author: reporter,
    targetKind,
    targetSeq,
    targetId,
    reason,
    reporter,
  };
  // Free path (no dust fee): bound operator-subsidized writes per wallet.
  const quota = await requireTownhallWriteQuota(s.session);
  if (quota) return quota;
  const seq = await deps.hcs.submit(topic, msg);
  return ok({ seq }, 201);
}

export interface QueryReportsBody extends AuthBody {
  username?: unknown;
}

/**
 * Moderator report queue: all kind "report" messages across the forum,
 * chat, and market topics, newest first. Mod-only — requires a global
 * moderator (TOWNHALL_MODS username or TOWNHALL_MOD_WALLETS wallet).
 */
export async function queryReports(deps: TownhallDeps, body: QueryReportsBody): Promise<HandlerResult> {
  const s = await requireSession(deps, body);
  if (!s.ok) return s.result;
  const username = typeof body.username === "string" ? body.username.trim() : "";
  if (!isGlobalMod(username, s.session.address)) {
    return err(403, "moderator access required");
  }
  const out: ReportView[] = [];
  for (const domain of ["forum", "chat", "market"] as TopicDomain[]) {
    const topic = getTopicId(domain);
    if (!topic) continue;
    const messages = await deps.hcs.queryAll(topic);
    for (const m of messages) {
      if (m.contents.kind !== "report") continue;
      const r = m.contents as ReportMessage;
      out.push({
        seq: m.seq,
        targetKind: r.targetKind,
        targetSeq: r.targetSeq,
        targetId: r.targetId,
        reason: r.reason,
        reporter: r.reporter,
        ts: r.ts,
      });
    }
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return ok({ reports: out });
}

export interface ModStatusBody extends AuthBody {
  username?: unknown;
  wall?: unknown;
}

/**
 * Tells the UI what the signed-in identity may moderate: global mods (by
 * TOWNHALL_MODS username or TOWNHALL_MOD_WALLETS wallet) can hide anywhere;
 * a page owner can hide on their own wall. 401 without a valid session, 403
 * when the claimed username isn't owned by the wallet (unless the wallet
 * itself is a mod wallet, which needs no registered page).
 */
export async function getModStatus(deps: TownhallDeps, body: ModStatusBody): Promise<HandlerResult> {
  const actor = await requireModActor(deps, body, body.username, "username");
  if (!actor.ok) return actor.result;
  const username = actor.name;
  const wall = typeof body.wall === "string" && body.wall.trim() ? body.wall.trim() : null;
  const globalMod = isGlobalMod(username, actor.session.address);
  return ok({
    username,
    isMod: globalMod,
    canModerateWall: wall ? globalMod || wall.toLowerCase() === username.toLowerCase() : false,
  });
}

/* ------------------------------------------------------------------ */
/* Events                                                             */
/* ------------------------------------------------------------------ */

export async function getEvents(deps: TownhallDeps): Promise<HandlerResult> {
  const topic = topicOr503("governance");
  if (typeof topic !== "string") return topic;
  const messages = await deps.hcs.queryAll(topic);
  const events: EventView[] = [];
  for (const m of messages) {
    if (m.contents.kind !== "event") continue;
    const e = m.contents as EventMessage;
    events.push({
      id: e.id,
      title: e.title,
      description: e.description,
      startsAt: e.startsAt,
      room: e.room,
    });
  }
  events.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return ok({ events });
}

export interface CreateEventBody extends AuthBody {
  author?: unknown;
  title?: unknown;
  description?: unknown;
  startsAt?: unknown;
}

export async function createEvent(deps: TownhallDeps, body: CreateEventBody): Promise<HandlerResult> {
  const actor = await requireModActor(deps, body, body.author);
  if (!actor.ok) return actor.result;
  const author = actor.name;
  if (!isGlobalMod(author, actor.session.address))
    return err(403, "only Town Hall moderators (TOWNHALL_MODS usernames or TOWNHALL_MOD_WALLETS wallets) may create events");
  if (!isNonEmptyString(body.title)) return err(400, "title is required");
  if (!isNonEmptyString(body.description)) return err(400, "description is required");
  if (!isNonEmptyString(body.startsAt) || Number.isNaN(Date.parse(body.startsAt))) {
    return err(400, "startsAt must be an ISO-8601 date");
  }
  // Free path (no dust fee, mods only): bound operator-subsidized writes.
  const quota = await requireTownhallWriteQuota(actor.session);
  if (quota) return quota;
  const topic = topicOr503("governance");
  if (typeof topic !== "string") return topic;
  const id = makeId(body.title);
  const msg: EventMessage = {
    v: 1,
    kind: "event",
    ts: new Date().toISOString(),
    author,
    id,
    title: body.title.trim(),
    description: body.description,
    startsAt: new Date(body.startsAt).toISOString(),
    room: `event-${id}`,
  };
  await deps.hcs.submit(topic, msg);
  return ok({ id }, 201);
}

/* ------------------------------------------------------------------ */
/* Listings                                                           */
/* ------------------------------------------------------------------ */

export async function getListings(deps: TownhallDeps): Promise<HandlerResult> {
  const topic = topicOr503("market");
  if (typeof topic !== "string") return topic;
  const messages = await deps.hcs.queryAll(topic);
  const latest = aggregateListings(messages);
  const views: ListingView[] = [...latest.values()]
    .sort((a, b) => b.seq - a.seq)
    .map((m) => ({
      id: m.contents.id,
      seller: m.contents.seller,
      sellerUsername:
        m.contents.sellerUsername ??
        (!looksLikeAddress(m.contents.seller) ? m.contents.seller : null),
      title: m.contents.title,
      description: m.contents.description,
      priceUsdCents: m.contents.priceUsdCents,
      goodsType: m.contents.goodsType,
      ipfsHash: m.contents.ipfsHash,
      status: m.contents.status,
      ts: m.contents.ts,
    }));
  return ok({ listings: views });
}

export interface CreateListingBody extends AuthBody {
  seller?: unknown;
  sellerUsername?: unknown;
  title?: unknown;
  description?: unknown;
  priceUsdCents?: unknown;
  goodsType?: unknown;
  ipfsHash?: unknown;
  dustFeeTxId?: unknown;
}

/** True for an EVM address or a Hedera 0.0.x account id. */
function looksLikeAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s) || /^\d+\.\d+\.\d+$/.test(s);
}

export async function createListing(deps: TownhallDeps, body: CreateListingBody): Promise<HandlerResult> {
  // The claimed page username must resolve on-chain to the signing wallet.
  // `seller` stays the direct-sale payout address — never an identity.
  const own = await requirePageOwner(deps, body, body.sellerUsername, "sellerUsername");
  if (!own.ok) return own.result;
  const sellerUsername = own.username;
  const payout = typeof body.seller === "string" ? body.seller.trim() : "";
  if (!looksLikeAddress(payout)) {
    return err(400, "seller must be a valid payout address (0x… or 0.0.x)");
  }
  if (!isNonEmptyString(body.title)) return err(400, "title is required");
  if (!isNonEmptyString(body.description)) return err(400, "description is required");
  if (typeof body.priceUsdCents !== "number" || !Number.isInteger(body.priceUsdCents) || body.priceUsdCents < 0) {
    return err(400, "priceUsdCents must be a non-negative integer");
  }
  if (body.goodsType !== "physical" && body.goodsType !== "digital") {
    return err(400, 'goodsType must be "physical" or "digital"');
  }
  const ipfsHash = typeof body.ipfsHash === "string" && body.ipfsHash.trim() ? body.ipfsHash.trim() : null;
  const gateTitle = safetyGate("listing title", body.title.trim(), "marketplace listing");
  if (gateTitle) return gateTitle;
  const gateDesc = safetyGate("listing description", body.description, "marketplace listing");
  if (gateDesc) return gateDesc;
  const fee = await requireDustFee(deps, own.session, body.dustFeeTxId);
  if (fee) return fee;
  const topic = topicOr503("market");
  if (typeof topic !== "string") return topic;
  const id = makeId(body.title);
  const msg: ListingMessage = {
    v: 1,
    kind: "listing",
    ts: new Date().toISOString(),
    author: sellerUsername,
    id,
    seller: payout,
    sellerUsername,
    title: body.title.trim(),
    description: body.description,
    priceUsdCents: body.priceUsdCents,
    goodsType: body.goodsType,
    ipfsHash,
    status: "active",
  };
  await deps.hcs.submit(topic, msg);
  return ok({ id }, 201);
}

export interface SetListingStatusBody extends AuthBody {
  sellerUsername?: unknown;
  status?: unknown;
}

export async function setListingStatus(
  deps: TownhallDeps,
  listingId: string,
  body: SetListingStatusBody,
): Promise<HandlerResult> {
  // The caller must sign in as the wallet that owns the claimed seller page.
  const own = await requirePageOwner(deps, body, body.sellerUsername, "sellerUsername");
  if (!own.ok) return own.result;
  if (body.status !== "sold" && body.status !== "cancelled") {
    return err(400, 'status must be "sold" or "cancelled"');
  }
  const topic = topicOr503("market");
  if (typeof topic !== "string") return topic;
  const messages = await deps.hcs.queryAll(topic);
  const latest = aggregateListings(messages).get(listingId);
  if (!latest) return err(404, `listing "${listingId}" not found`);
  // Legacy listings (pre sellerUsername) stored the username in `seller`.
  const storedSeller =
    latest.contents.sellerUsername ??
    (!looksLikeAddress(latest.contents.seller) ? latest.contents.seller : null);
  if (!storedSeller || storedSeller.toLowerCase() !== own.username.toLowerCase()) {
    return err(403, "only the seller may change the listing status");
  }
  const updated: ListingMessage = {
    ...latest.contents,
    sellerUsername: storedSeller,
    ts: new Date().toISOString(),
    author: own.username,
    status: body.status,
  };
  // Free path (no dust fee): bound operator-subsidized writes per wallet.
  const quota = await requireTownhallWriteQuota(own.session);
  if (quota) return quota;
  await deps.hcs.submit(topic, updated);
  return ok({});
}
