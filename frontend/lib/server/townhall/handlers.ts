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
import { canonicalAddress } from "../../session-message";
import type { HcsPort } from "./hcs";
import { defaultHcsPort } from "./hcs";
import type { MirrorPort } from "./mirror";
import { consumeDustFeeTx, defaultMirrorPort, releaseDustFeeTx, reserveDustFeeTx } from "./mirror";
import { filterHiddenPosts, isAuthorizedModAction, isGlobalMod, isModWallet, isOwnerAddress } from "./mod";
import type { RegistryPort } from "./registry-check";
import { defaultRegistryPort } from "./registry-check";
import type { AuthPort, VerifiedSession } from "./auth";
import { defaultAuthPort } from "./auth";
import type { SalesPort } from "./sales";
import { defaultSalesPort } from "./sales";
import { globalQuotaStore, quotaExceededBody, quotaLimitFromEnv } from "../quota";
import { getTopicId, mirrorBaseUrl, type TopicDomain } from "./topics";
import { checkContent } from "./content-filter";
import { ethers } from "ethers";
import {
  collectAppealEvents,
  collectEnforcementEvents,
  formatRemaining,
  getActiveBans,
  getActiveTimeouts,
  getActiveWarnings,
  getBanFor,
  getEnforcementState,
  getPendingAppeals,
  getStateFor,
  hasPendingAppeal,
  MAX_TIMEOUT_MINUTES,
  pendingAppeals,
  requireNotRestricted,
  suggestEnforcement,
  type ViolationSeverity,
} from "./bans";
import type {
  AppealMessage,
  AppealResolveMessage,
  AppealView,
  BanMessage,
  BanView,
  ChatEvent,
  ChatMessage,
  ChatRoom,
  ChatRoomMessage,
  EnforcementStateSummary,
  EnforcementSuggestion,
  EventMessage,
  EventView,
  ListingMessage,
  ListingView,
  ModActionMessage,
  PostMessage,
  PostView,
  ProfileLinksMessage,
  ProfileLinksView,
  ProposalMessage,
  ProposalView,
  ProposalVoteMessage,
  ReferralMessage,
  ReferralStatsView,
  ReportMessage,
  ReportView,
  RepVoteMessage,
  ReputationView,
  StoredMessage,
  TimeoutMessage,
  TimeoutView,
  UnbanMessage,
  WarnMessage,
  WarnView,
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
  // The treasury owner doesn't pay the dust fee to themselves — Hedera
  // rejects self-transfers (ACCOUNT_REPEATED_IN_ACCOUNT_AMOUNTS).
  // isOwnerAddress matches the owner's ECDSA-derived EVM address as well
  // as the 0.0.x/long-zero forms (canonicalAddress alone can't match the
  // ECDSA form).
  if (isOwnerAddress(session.address)) {
    return null; // Owner posts free
  }
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

/**
 * Windowed forum-post query for the SSE stream. Same visibility rules as
 * getPosts (mod-hides apply), but reads only messages after `afterSeq`
 * instead of the full topic history. `board` filters to one board (null =
 * all boards).
 */
export async function queryPostViews(
  deps: TownhallDeps,
  board: string | null,
  afterSeq = 0,
): Promise<PostView[]> {
  const topic = getTopicId("forum");
  if (!topic) return [];
  const messages = await deps.hcs.query(topic, { afterSeq, limit: 100 });
  const posts = collectPosts(messages);
  const mods = messages
    .filter((m): m is StoredMessage<ModActionMessage> => m.contents.kind === "mod-action")
    .map((m) => m.contents);
  const visible = filterHiddenPosts(
    posts.map((p) => ({ ...p, board: p.contents.board, wall: p.contents.wall })),
    mods,
  );
  const visibleSeqs = new Set(visible.map((v) => v.seq));
  const want = board ? board.toLowerCase() : null;
  return posts
    .filter((p) => visibleSeqs.has(p.seq))
    .filter((p) => !want || p.contents.board.toLowerCase() === want)
    .map((p) => ({
      seq: p.seq,
      board: p.contents.board,
      wall: p.contents.wall,
      author: p.contents.author,
      body: p.contents.body,
      replyTo: p.contents.replyTo,
      ts: p.contents.ts,
    }));
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
  // Restricted wallets (timed out / banned) are stopped BEFORE the dust fee — they are never charged.
  const restricted = await requireNotRestricted(deps, actor.session.address);
  if (restricted) return restricted;
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
  const restricted = await requireNotRestricted(deps, own.session.address);
  if (restricted) return restricted;
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
  // Restricted wallets (timed out / banned) cannot cast reputation votes.
  const restricted = await requireNotRestricted(deps, own.session.address);
  if (restricted) return restricted;
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

/** Minimal stream event for polls: enough for the client to know a refetch is needed. */
export interface ProposalStreamEvent {
  seq: number;
  kind: "proposal" | "proposal-vote";
  /** Proposal id the event belongs to. */
  id: string;
}

/**
 * Windowed proposal/vote query for the SSE stream. The client refetches the
 * full proposal list (with tallies) when any of these arrive — the list is
 * small, so a refetch is cheaper than streaming computed tallies.
 */
export async function queryProposalEvents(
  deps: TownhallDeps,
  afterSeq = 0,
): Promise<ProposalStreamEvent[]> {
  const topic = getTopicId("governance");
  if (!topic) return [];
  const messages = await deps.hcs.query(topic, { afterSeq, limit: 100 });
  const out: ProposalStreamEvent[] = [];
  for (const m of messages) {
    if (m.contents.kind === "proposal") {
      out.push({ seq: m.seq, kind: "proposal", id: (m.contents as ProposalMessage).id });
    } else if (m.contents.kind === "proposal-vote") {
      out.push({ seq: m.seq, kind: "proposal-vote", id: (m.contents as ProposalVoteMessage).proposal });
    }
  }
  return out;
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
  // Restricted wallets (timed out / banned) are stopped BEFORE the dust fee — they are never charged.
  const restricted = await requireNotRestricted(deps, own.session.address);
  if (restricted) return restricted;
  const gateTitle = safetyGate("proposal title", body.title, "proposal");
  if (gateTitle) return gateTitle;
  const gateBody = safetyGate("proposal body", body.body, "proposal");
  if (gateBody) return gateBody;
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
  // Restricted wallets (timed out / banned) cannot vote on proposals.
  const restricted = await requireNotRestricted(deps, own.session.address);
  if (restricted) return restricted;
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
  const restricted = await requireNotRestricted(deps, own.session.address);
  if (restricted) return restricted;
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

type ReportTargetKind = "post" | "chat" | "listing" | "profile";

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
  const restricted = await requireNotRestricted(deps, s.session.address);
  if (restricted) return restricted;
  const targetKind = body.targetKind;
  if (targetKind !== "post" && targetKind !== "chat" && targetKind !== "listing" && targetKind !== "profile") {
    return err(400, 'targetKind must be "post", "chat", "listing", or "profile"');
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
  const gate = safetyGate("report reason", reason, "report");
  if (gate) return gate;

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
  } else if (targetKind === "profile") {
    if (typeof body.targetId !== "string" || !body.targetId.trim()) {
      return err(400, "targetId is required for profile reports (the reported username)");
    }
    targetId = body.targetId.trim().replace(/^@+/, "").toLowerCase();
    let owner: string | null = null;
    try {
      owner = await deps.registry.resolveOwner(targetId);
    } catch {
      // Registry hiccup — fail open would let fake profiles be reported;
      // fail closed here instead: the report target must be verifiable.
    }
    if (!owner) {
      return err(404, `page "${targetId}" is not registered`);
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

/* ------------------------------------------------------------------ */
/* Wallet bans                                                        */
/* ------------------------------------------------------------------ */

/**
 * Require a global moderator for ban management: a TOWNHALL_MODS username
 * or a TOWNHALL_MOD_WALLETS wallet. 401 without a valid session, 403
 * otherwise. Returns the acting identity for authorship.
 */
async function requireBanMod(
  deps: TownhallDeps,
  body: AuthBody & { username?: unknown },
): Promise<{ ok: true; name: string; session: VerifiedSession } | { ok: false; result: HandlerResult }> {
  const s = await requireSession(deps, body);
  if (!s.ok) return s;
  const username = typeof body.username === "string" ? body.username.trim() : "";
  if (!isGlobalMod(username, s.session.address)) {
    return { ok: false, result: err(403, "moderator access required") };
  }
  return { ok: true, name: username || s.session.address, session: s.session };
}

export interface BanUserBody extends AuthBody {
  username?: unknown;
  /** Wallet to ban: Hedera account id (0.0.x) or EVM 0x address. */
  wallet?: unknown;
  /** Informational username of the target, never used for enforcement. */
  targetUsername?: unknown;
  /** Reason shown to the banned user, 10–200 chars. */
  reason?: unknown;
  /** Optional unix ms when the ban lifts; omit for permanent. */
  expiresAt?: unknown;
}

/**
 * Validate the shared fields of warn/timeout/ban bodies: a canonical
 * wallet, a 10–200 char reason, and an optional informational username.
 */
function parseEnforcementTarget(body: {
  wallet?: unknown;
  targetUsername?: unknown;
  reason?: unknown;
}): { ok: true; wallet: string; username: string | null; reason: string } | { ok: false; result: HandlerResult } {
  const rawWallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  const wallet = canonicalAddress(rawWallet);
  if (!wallet) {
    return { ok: false, result: err(400, "wallet must be a valid Hedera account id (0.0.x) or EVM address (0x…)") };
  }
  if (typeof body.reason !== "string" || body.reason.trim().length < 10) {
    return { ok: false, result: err(400, "reason must be at least 10 characters") };
  }
  const reason = body.reason.trim();
  if (reason.length > 200) return { ok: false, result: err(400, "reason too long (max 200 chars)") };
  const username =
    typeof body.targetUsername === "string" && body.targetUsername.trim() ? body.targetUsername.trim() : null;
  return { ok: true, wallet, username, reason };
}

/**
 * Publish an enforcement record to the forum topic with the mod free-write
 * quota applied (no dust fee for moderators).
 */
async function submitEnforcement(
  deps: TownhallDeps,
  topic: string,
  session: VerifiedSession,
  msg: WarnMessage | TimeoutMessage | BanMessage | UnbanMessage | AppealResolveMessage,
): Promise<HandlerResult> {
  const quota = await requireTownhallWriteQuota(session);
  if (quota) return quota;
  const seq = await deps.hcs.submit(topic, msg);
  return ok({ seq, wallet: msg.wallet }, 201);
}

/**
 * Ban a wallet from all town-hall writes. Mod-only. The ban is published
 * as kind "ban" on the forum topic (auditable, permanent record) and takes
 * effect on the next write — the forum topic cache is invalidated by the
 * submit, and the 30s query cache means at most seconds of staleness.
 *
 * 201 → {seq, wallet}. Errors: 400 bad input, 401 no session, 403 not a
 * moderator, 409 wallet already banned.
 */
export async function banUser(deps: TownhallDeps, body: BanUserBody): Promise<HandlerResult> {
  const mod = await requireBanMod(deps, body);
  if (!mod.ok) return mod.result;
  const target = parseEnforcementTarget(body);
  if (!target.ok) return target.result;
  const { wallet, username, reason } = target;
  let expiresAt: number | null = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    if (typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now()) {
      return err(400, "expiresAt must be a unix-ms timestamp in the future");
    }
    expiresAt = Math.floor(body.expiresAt);
  }
  // Idempotency: refuse to double-ban an already-restricted wallet.
  const state = await getStateFor(deps, wallet);
  if (state.status === "banned" || state.status === "temp-banned" || state.status === "timed-out") {
    return err(409, `wallet ${wallet} is already restricted (${state.status})`);
  }
  const topic = topicOr503("forum");
  if (typeof topic !== "string") return topic;
  const msg: BanMessage = {
    v: 1,
    kind: "ban",
    ts: new Date().toISOString(),
    author: mod.name,
    wallet,
    username,
    reason,
    bannedBy: mod.name,
    expiresAt,
  };
  return submitEnforcement(deps, topic, mod.session, msg);
}

export interface UnbanUserBody extends AuthBody {
  username?: unknown;
  /** Wallet to unban: Hedera account id (0.0.x) or EVM 0x address. */
  wallet?: unknown;
}

/**
 * Lift a wallet restriction (ban or timeout). Mod-only. Publishes kind
 * "unban" on the forum topic; latest-wins semantics mean the restriction
 * stops applying immediately.
 *
 * 201 → {seq, wallet}. Errors: 400 bad input, 401 no session, 403 not a
 * moderator, 404 wallet is not currently restricted.
 */
/**
 * Lift a wallet's enforcement state (warning, timeout, or ban).
 * Mod-only. Publishes kind "unban" on the forum topic; the latest-wins
 * state machine clears the wallet back to clean, so this also lifts
 * warnings (which otherwise never expire).
 *
 * 201 → {seq, wallet}. Errors: 400 bad input, 401 no session, 403 not a
 * moderator, 404 wallet has no enforcement record to lift.
 */
export async function unbanUser(deps: TownhallDeps, body: UnbanUserBody): Promise<HandlerResult> {
  const mod = await requireBanMod(deps, body);
  if (!mod.ok) return mod.result;
  const rawWallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  const wallet = canonicalAddress(rawWallet);
  if (!wallet) {
    return err(400, "wallet must be a valid Hedera account id (0.0.x) or EVM address (0x…)");
  }
  const state = await getStateFor(deps, wallet);
  if (state.status === "clean") {
    return err(404, `wallet ${wallet} has no enforcement record to lift`);
  }
  const topic = topicOr503("forum");
  if (typeof topic !== "string") return topic;
  const msg: UnbanMessage = {
    v: 1,
    kind: "unban",
    ts: new Date().toISOString(),
    author: mod.name,
    wallet,
    unbannedBy: mod.name,
  };
  return submitEnforcement(deps, topic, mod.session, msg);
}

export interface WarnUserBody extends AuthBody {
  username?: unknown;
  /** Wallet to warn: Hedera account id (0.0.x) or EVM 0x address. */
  wallet?: unknown;
  /** Informational username of the target, never used for enforcement. */
  targetUsername?: unknown;
  /** Reason shown to the warned user, 10–200 chars. */
  reason?: unknown;
}

/**
 * Issue a formal warning. Mod-only. No write restriction — a logged,
 * visible notice and the first rung of the escalation ladder.
 *
 * 201 → {seq, wallet}. Errors: 400 bad input, 401 no session, 403 not a
 * moderator.
 */
export async function warnUser(deps: TownhallDeps, body: WarnUserBody): Promise<HandlerResult> {
  const mod = await requireBanMod(deps, body);
  if (!mod.ok) return mod.result;
  const target = parseEnforcementTarget(body);
  if (!target.ok) return target.result;
  const { wallet, username, reason } = target;
  const topic = topicOr503("forum");
  if (typeof topic !== "string") return topic;
  const msg: WarnMessage = {
    v: 1,
    kind: "warn",
    ts: new Date().toISOString(),
    author: mod.name,
    wallet,
    username,
    reason,
    warnedBy: mod.name,
  };
  return submitEnforcement(deps, topic, mod.session, msg);
}

export interface TimeoutUserBody extends AuthBody {
  username?: unknown;
  /** Wallet to time out: Hedera account id (0.0.x) or EVM 0x address. */
  wallet?: unknown;
  /** Informational username of the target, never used for enforcement. */
  targetUsername?: unknown;
  /** Reason shown to the timed-out user, 10–200 chars. */
  reason?: unknown;
  /** Timeout length in minutes: 1–43200 (30 days max; longer → temp ban). */
  durationMinutes?: unknown;
}

/**
 * Time a wallet out: no writes until expiresAt. Mod-only. Auto-expires;
 * a later unban or appeal resolution (lifted) clears it early.
 *
 * 201 → {seq, wallet, expiresAt}. Errors: 400 bad input, 401 no session,
 * 403 not a moderator, 409 wallet already restricted.
 */
export async function timeoutUser(deps: TownhallDeps, body: TimeoutUserBody): Promise<HandlerResult> {
  const mod = await requireBanMod(deps, body);
  if (!mod.ok) return mod.result;
  const target = parseEnforcementTarget(body);
  if (!target.ok) return target.result;
  const { wallet, username, reason } = target;
  if (
    typeof body.durationMinutes !== "number" ||
    !Number.isFinite(body.durationMinutes) ||
    body.durationMinutes < 1 ||
    body.durationMinutes > MAX_TIMEOUT_MINUTES
  ) {
    return err(400, `durationMinutes must be 1–${MAX_TIMEOUT_MINUTES}`);
  }
  const durationMinutes = Math.floor(body.durationMinutes);
  const state = await getStateFor(deps, wallet);
  if (state.status === "banned" || state.status === "temp-banned" || state.status === "timed-out") {
    return err(409, `wallet ${wallet} is already restricted (${state.status})`);
  }
  const topic = topicOr503("forum");
  if (typeof topic !== "string") return topic;
  const msg: TimeoutMessage = {
    v: 1,
    kind: "timeout",
    ts: new Date().toISOString(),
    author: mod.name,
    wallet,
    username,
    reason,
    timedOutBy: mod.name,
    durationMinutes,
    expiresAt: Date.now() + durationMinutes * 60000,
  };
  const res = await submitEnforcement(deps, topic, mod.session, msg);
  if (res.status === 201) {
    return ok({ ...(res.json as Record<string, unknown>), expiresAt: msg.expiresAt }, 201);
  }
  return res;
}

export interface ListBansBody extends AuthBody {
  username?: unknown;
}

/**
 * Active enforcement list: current bans (temp + permanent) and timeouts,
 * newest first. Mod-only (reasons and targets are not public).
 */
export async function listBans(deps: TownhallDeps, body: ListBansBody): Promise<HandlerResult> {
  const mod = await requireBanMod(deps, body);
  if (!mod.ok) return mod.result;
  const bans: BanView[] = await getActiveBans(deps);
  const timeouts: TimeoutView[] = await getActiveTimeouts(deps);
  return ok({ bans, timeouts });
}

export interface ListWarningsBody extends AuthBody {
  username?: unknown;
}

/**
 * Active warnings list, newest first. Mod-only (reasons and targets are
 * not public). Warnings never expire; a warning disappears from this
 * list only when a later enforcement event supersedes it for that wallet.
 */
export async function listWarnings(deps: TownhallDeps, body: ListWarningsBody): Promise<HandlerResult> {
  const mod = await requireBanMod(deps, body);
  if (!mod.ok) return mod.result;
  const warnings: WarnView[] = await getActiveWarnings(deps);
  return ok({ warnings });
}

export interface ResolveReportTargetBody extends AuthBody {
  username?: unknown;
  /** "post" | "chat" | "listing" | "profile". */
  targetKind?: unknown;
  /** HCS sequence number for post/chat targets. */
  targetSeq?: unknown;
  /** Listing id for listing targets, username for profile targets. */
  targetId?: unknown;
}

/**
 * Resolve a report's target to the offending identity: the author's
 * registered username and their canonical wallet address, so a
 * moderator can issue warn/timeout/ban from the report queue. Mod-only.
 * Returns {username, wallet} — wallet may be null when the username has
 * no resolvable on-chain owner (e.g. an unregistered chat alias).
 */
export async function resolveReportTarget(
  deps: TownhallDeps,
  body: ResolveReportTargetBody,
): Promise<HandlerResult> {
  const mod = await requireBanMod(deps, body);
  if (!mod.ok) return mod.result;
  const targetKind = body.targetKind;
  if (targetKind !== "post" && targetKind !== "chat" && targetKind !== "listing" && targetKind !== "profile") {
    return err(400, 'targetKind must be "post", "chat", "listing", or "profile"');
  }
  let username: string | null = null;
  if (targetKind === "listing") {
    if (typeof body.targetId !== "string" || !body.targetId.trim()) {
      return err(400, "targetId is required for listing targets");
    }
    const topic = getTopicId("market");
    if (!topic) return err(503, "marketplace topic not configured");
    let messages;
    try {
      messages = await deps.hcs.queryAll(topic);
    } catch {
      return err(502, "could not read marketplace records — try again");
    }
    const listing = aggregateListings(messages).get(body.targetId.trim());
    if (!listing) return err(404, `listing "${body.targetId.trim()}" not found`);
    username = (listing.contents.sellerUsername ?? listing.contents.seller ?? "").trim() || null;
  } else if (targetKind === "profile") {
    if (typeof body.targetId !== "string" || !body.targetId.trim()) {
      return err(400, "targetId is required for profile targets (the reported username)");
    }
    username = body.targetId.trim().replace(/^@+/, "").toLowerCase() || null;
  } else {
    if (typeof body.targetSeq !== "number" || !Number.isInteger(body.targetSeq) || body.targetSeq <= 0) {
      return err(400, "targetSeq must be a positive integer");
    }
    const domain: TopicDomain = targetKind === "chat" ? "chat" : "forum";
    const topic = getTopicId(domain);
    if (!topic) return err(503, "topic not configured");
    let messages;
    try {
      messages = await deps.hcs.queryAll(topic);
    } catch {
      return err(502, "could not read records — try again");
    }
    const wantKind = targetKind === "chat" ? "chat" : "post";
    const found = messages.find((m) => m.seq === body.targetSeq && m.contents.kind === wantKind);
    if (!found) return err(404, `${wantKind} #${body.targetSeq} not found`);
    const contents = found.contents as { author?: unknown };
    username = typeof contents.author === "string" && contents.author.trim() ? contents.author.trim() : null;
  }
  let wallet: string | null = null;
  if (username) {
    try {
      const owner = await deps.registry.resolveOwner(username.replace(/^@+/, "").toLowerCase());
      wallet = owner ? canonicalAddress(owner) : null;
    } catch {
      wallet = null; // registry hiccup — return the username; mod can act once resolvable
    }
  }
  return ok({ username, wallet });
}

/**
 * The signed-in wallet's own enforcement state. Session required —
 * anyone may check their own restriction, so there is no mod gate.
 * Fail-open: when HCS is unreadable the wallet reports clean (the write
 * path still enforces independently).
 */
export async function getMyRestriction(deps: TownhallDeps, body: AuthBody): Promise<HandlerResult> {
  const s = await requireSession(deps, body);
  if (!s.ok) return s.result;
  const wallet = canonicalAddress(s.session.address);
  if (!wallet) return err(401, "invalid session wallet");
  const state = await getStateFor(deps, wallet);
  return ok({
    status: state.status,
    reason: state.reason,
    remainingMs: state.remainingMs,
    expiresAt: state.expiresAt,
  });
}

export interface SuggestEnforcementBody extends AuthBody {
  username?: unknown;
  /** Wallet to evaluate: Hedera account id (0.0.x) or EVM 0x address. */
  wallet?: unknown;
  /** Severity of the current violation. */
  severity?: unknown;
}

/**
 * Recommend the next enforcement step for a wallet from its HCS history
 * and the violation severity. Mod-only. Advisory — the moderator makes
 * the call (and may skip levels for severe violations).
 */
export async function suggestEnforcementAction(
  deps: TownhallDeps,
  body: SuggestEnforcementBody,
): Promise<HandlerResult> {
  const mod = await requireBanMod(deps, body);
  if (!mod.ok) return mod.result;
  const rawWallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  const wallet = canonicalAddress(rawWallet);
  if (!wallet) {
    return err(400, "wallet must be a valid Hedera account id (0.0.x) or EVM address (0x…)");
  }
  const severity = body.severity;
  if (severity !== "low" && severity !== "medium" && severity !== "high" && severity !== "critical") {
    return err(400, 'severity must be "low", "medium", "high", or "critical"');
  }
  const topic = getTopicId("forum");
  let events: ReturnType<typeof collectEnforcementEvents> = [];
  if (topic) {
    try {
      events = collectEnforcementEvents(await deps.hcs.queryAll(topic));
    } catch {
      // History unreadable — suggest from zero history.
    }
  }
  const suggestion: EnforcementSuggestion = suggestEnforcement(wallet, severity as ViolationSeverity, events);
  const state = getEnforcementState(wallet, events);
  return ok({ wallet, severity, suggestion, currentState: { status: state.status, reason: state.reason } });
}

/* ------------------------------------------------------------------ */
/* Appeals                                                          */
/* ------------------------------------------------------------------ */

export interface SubmitAppealBody extends AuthBody {
  /** Appellant's case, 20–500 chars. Not content-filtered. */
  reason?: unknown;
}

/**
 * Appeal a timeout or ban. The restricted user files this themselves —
 * no page ownership, no dust fee, no restriction check (a banned user
 * must always be able to be heard). One pending appeal per wallet.
 *
 * The appeal lands on the forum topic as kind "appeal". Like reports,
 * the reason is NOT run through the content filter: an appellant
 * describing the offending content must not be blocked for quoting it.
 *
 * 201 → {seq}. Errors: 400 bad input / no active restriction, 401 no
 * session, 409 appeal already pending, 429 daily quota exceeded.
 */
export async function submitAppeal(deps: TownhallDeps, body: SubmitAppealBody): Promise<HandlerResult> {
  const s = await requireSession(deps, body);
  if (!s.ok) return s.result;
  const wallet = canonicalAddress(s.session.address);
  if (!wallet) return err(401, "invalid session wallet");
  const state = await getStateFor(deps, wallet);
  if (state.status === "clean" || state.status === "warned") {
    return err(400, "no active timeout or ban to appeal");
  }
  if (typeof body.reason !== "string" || body.reason.trim().length < 20) {
    return err(400, "reason must be at least 20 characters");
  }
  const reason = body.reason.trim();
  if (reason.length > 500) return err(400, "reason too long (max 500 chars)");
  // Appeals come from restricted wallets by design (no restriction check
  // here), but the free-text reason still passes the safety filter before
  // it is written to immutable HCS.
  const gate = safetyGate("appeal reason", reason, "appeal");
  if (gate) return gate;
  const topic = topicOr503("forum");
  if (typeof topic !== "string") return topic;
  let messages;
  try {
    messages = await deps.hcs.queryAll(topic);
  } catch {
    return err(502, "could not read appeal records — try again");
  }
  const appeals = collectAppealEvents(messages);
  const resolutions = collectEnforcementEvents(messages).filter(
    (e): e is AppealResolveMessage => e.kind === "appeal-resolve",
  );
  if (hasPendingAppeal(appeals, resolutions, wallet)) {
    return err(409, "an appeal is already pending for this wallet");
  }
  const msg: AppealMessage = {
    v: 1,
    kind: "appeal",
    ts: new Date().toISOString(),
    author: s.session.address,
    wallet,
    reason,
  };
  // Free path (no dust fee): bound by the per-wallet daily quota like reports.
  const quota = await requireTownhallWriteQuota(s.session);
  if (quota) return quota;
  const seq = await deps.hcs.submit(topic, msg);
  return ok({ seq }, 201);
}

export interface QueryAppealsBody extends AuthBody {
  username?: unknown;
}

/**
 * Pending appeal queue, newest first. Mod-only.
 */
export async function queryAppeals(deps: TownhallDeps, body: QueryAppealsBody): Promise<HandlerResult> {
  const mod = await requireBanMod(deps, body);
  if (!mod.ok) return mod.result;
  const appeals: AppealView[] = await getPendingAppeals(deps);
  return ok({ appeals });
}

export interface ResolveAppealBody extends AuthBody {
  username?: unknown;
  /** Wallet whose appeal is resolved. */
  wallet?: unknown;
  /** "lifted" clears the restriction; "upheld" keeps it. */
  action?: unknown;
  /** Optional moderator note, max 200 chars. */
  note?: unknown;
}

/**
 * Resolve a pending appeal. Mod-only. Publishes kind "appeal-resolve" on
 * the forum topic; "lifted" clears the timeout/ban immediately via the
 * latest-wins state machine, "upheld" leaves it in force.
 *
 * 201 → {seq, wallet, action}. Errors: 400 bad input, 401 no session,
 * 403 not a moderator, 404 no pending appeal for this wallet.
 */
export async function resolveAppeal(deps: TownhallDeps, body: ResolveAppealBody): Promise<HandlerResult> {
  const mod = await requireBanMod(deps, body);
  if (!mod.ok) return mod.result;
  const rawWallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  const wallet = canonicalAddress(rawWallet);
  if (!wallet) {
    return err(400, "wallet must be a valid Hedera account id (0.0.x) or EVM address (0x…)");
  }
  if (body.action !== "upheld" && body.action !== "lifted") {
    return err(400, 'action must be "upheld" or "lifted"');
  }
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string" || body.note.trim().length > 200) {
      return err(400, "note too long (max 200 chars)");
    }
    note = body.note.trim() || null;
  }
  const topic = topicOr503("forum");
  if (typeof topic !== "string") return topic;
  let messages;
  try {
    messages = await deps.hcs.queryAll(topic);
  } catch {
    return err(502, "could not read appeal records — try again");
  }
  const appeals = collectAppealEvents(messages);
  const resolutions = collectEnforcementEvents(messages).filter(
    (e): e is AppealResolveMessage => e.kind === "appeal-resolve",
  );
  if (!hasPendingAppeal(appeals, resolutions, wallet)) {
    return err(404, `no pending appeal for wallet ${wallet}`);
  }
  const msg: AppealResolveMessage = {
    v: 1,
    kind: "appeal-resolve",
    ts: new Date().toISOString(),
    author: mod.name,
    wallet,
    resolvedBy: mod.name,
    action: body.action,
    note,
  };
  return submitEnforcement(deps, topic, mod.session, msg);
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
  const gateTitle = safetyGate("event title", body.title, "event");
  if (gateTitle) return gateTitle;
  const gateDesc = safetyGate("event description", body.description, "event");
  if (gateDesc) return gateDesc;
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

/**
 * Windowed listing query for the SSE stream. Each message maps to a
 * ListingView; the client upserts by id (latest message per id wins —
 * status updates are new messages with the same id). `seq` is included so
 * the SSE layer can track its position.
 */
export async function queryListingViews(
  deps: TownhallDeps,
  afterSeq = 0,
): Promise<(ListingView & { seq: number })[]> {
  const topic = getTopicId("market");
  if (!topic) return [];
  const messages = await deps.hcs.query(topic, { afterSeq, limit: 100 });
  return messages
    .filter((m): m is StoredMessage<ListingMessage> => m.contents.kind === "listing")
    .map((m) => ({
      seq: m.seq,
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
}

export interface SearchListingsParams {
  q?: string;
  /** Alias for goodsType: "physical" | "digital". */
  category?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  sort?: "newest" | "price-asc" | "price-desc";
  limit?: number;
}

export interface SearchListingView extends ListingView {
  /** Absolute deep link to the listing detail page. */
  url: string;
}

/**
 * Public marketplace search for external consumers (price-comparison
 * agents, etc.). Session-less, no auth — rate-limited at the route
 * layer. Only active listings are returned; seller payout addresses are
 * included (they're already public on the listings feed) but never
 * private wallet metadata.
 */
export async function searchListings(
  deps: TownhallDeps,
  params: SearchListingsParams,
  siteUrl: string,
): Promise<HandlerResult> {
  const topic = topicOr503("market");
  if (typeof topic !== "string") return topic;
  const messages = await deps.hcs.queryAll(topic);
  const latest = aggregateListings(messages);

  const q = (params.q ?? "").trim().toLowerCase();
  const category = (params.category ?? "").trim().toLowerCase();
  const minCents = params.minPriceCents;
  const maxCents = params.maxPriceCents;
  const sort = params.sort ?? "newest";
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);

  let views: SearchListingView[] = [];
  for (const m of latest.values()) {
    if (m.contents.status !== "active") continue;
    if (category && m.contents.goodsType !== category) continue;
    if (minCents !== undefined && m.contents.priceUsdCents < minCents) continue;
    if (maxCents !== undefined && m.contents.priceUsdCents > maxCents) continue;
    if (q) {
      const hay = `${m.contents.title} ${m.contents.description}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    views.push({
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
      url: `${siteUrl.replace(/\/$/, "")}/marketplace/${encodeURIComponent(m.contents.id)}`,
    });
  }

  if (sort === "price-asc") views.sort((a, b) => a.priceUsdCents - b.priceUsdCents);
  else if (sort === "price-desc") views.sort((a, b) => b.priceUsdCents - a.priceUsdCents);
  else views.sort((a, b) => (a.ts < b.ts ? 1 : -1));

  return ok({ listings: views.slice(0, limit), count: views.length });
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
  const restricted = await requireNotRestricted(deps, own.session.address);
  if (restricted) return restricted;
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

/* ------------------------------------------------------------------ */
/* Profile links (cross-platform identity)                            */
/* ------------------------------------------------------------------ */

export interface SetProfileLinksBody extends AuthBody {
  username?: unknown;
  links?: unknown;
}

const PROFILE_LINK_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Set cross-platform identity links for your own registered page
 * (twitter, github, website, farcaster, …). Lives on the forum topic as
 * kind "profile-links"; latest message per username wins.
 *
 * Auth: the signing wallet must own the claimed username (page owner).
 * No dust fee — declaring identity is free. Links are NOT run through
 * the content filter (they're short platform handles/URLs, validated by
 * shape), but values are length-bounded and key names are restricted to
 * safe slugs.
 *
 * 201 → {seq}. Errors: 400 bad input, 401 no session, 403 not the page
 * owner, 429 daily quota exceeded.
 */
export async function setProfileLinks(
  deps: TownhallDeps,
  body: SetProfileLinksBody,
): Promise<HandlerResult> {
  const own = await requirePageOwner(deps, body, body.username, "username");
  if (!own.ok) return own.result;
  const restricted = await requireNotRestricted(deps, own.session.address);
  if (restricted) return restricted;

  if (body.links === null || typeof body.links !== "object" || Array.isArray(body.links)) {
    return err(400, "links must be an object of platform → handle/URL");
  }
  const entries = Object.entries(body.links as Record<string, unknown>);
  if (entries.length > 20) return err(400, "too many links (max 20)");
  const links: Record<string, string> = {};
  for (const [k, v] of entries) {
    const key = k.trim().toLowerCase();
    if (!PROFILE_LINK_KEY_RE.test(key)) {
      return err(400, `invalid link platform "${k}" — use lowercase letters, digits, - or _ (max 32 chars)`);
    }
    if (typeof v !== "string" || !v.trim()) {
      return err(400, `link "${key}" must be a non-empty string`);
    }
    const val = v.trim();
    if (val.length > 200) return err(400, `link "${key}" too long (max 200 chars)`);
    links[key] = val;
  }

  const topic = topicOr503("forum");
  if (typeof topic !== "string") return topic;
  const msg: ProfileLinksMessage = {
    v: 1,
    kind: "profile-links",
    ts: new Date().toISOString(),
    author: own.username,
    username: own.username.toLowerCase(),
    links,
  };
  // Free path (no dust fee): bound operator-subsidized writes per wallet.
  const quota = await requireTownhallWriteQuota(own.session);
  if (quota) return quota;
  const seq = await deps.hcs.submit(topic, msg);
  return ok({ seq }, 201);
}

/**
 * Read a user's cross-platform identity links. Session-less public read —
 * latest kind "profile-links" message for the username wins.
 * 200 → {links: {}} when none set.
 */
export async function getProfileLinks(
  deps: TownhallDeps,
  username: string,
): Promise<HandlerResult> {
  const topic = topicOr503("forum");
  if (typeof topic !== "string") return topic;
  const name = username.trim().toLowerCase();
  if (!name) return err(400, "username is required");
  const messages = await deps.hcs.queryAll(topic);
  let latest: ProfileLinksView | null = null;
  for (const m of messages) {
    if (m.contents.kind !== "profile-links") continue;
    const c = m.contents as ProfileLinksMessage;
    if (c.username !== name) continue;
    latest = { username: name, links: c.links, ts: c.ts };
  }
  return ok(latest ?? { username: name, links: {}, ts: "" });
}

/* ------------------------------------------------------------------ */
/* Referrals — growth loop                                            */
/* ------------------------------------------------------------------ */

export interface RecordReferralBody extends AuthBody {
  /** The referred user's own username (must own this page). */
  referredUsername?: unknown;
  /** The referrer's username (?ref= value). */
  referrer?: unknown;
}

const REFERRAL_USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/;
/** Referrals must be recorded within 7 days of page registration. */
const REFERRAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** keccak256("PageRegistered(string,address,string,uint8,address,string)") — topics[0]. */
const PAGE_REGISTERED_TOPIC0 = ethers.id(
  "PageRegistered(string,address,string,uint8,address,string)",
);

/**
 * Unix-ms consensus timestamp of the most recent PageRegistered event for
 * a username, via the free mirror node. Null when unknown (contract not
 * configured, mirror down, or no event found) — callers fail open.
 */
async function pageRegisteredAt(username: string): Promise<number | null> {
  const contract = process.env.NEXT_PUBLIC_REGISTRY_ADDRESS?.trim();
  if (!contract) return null;
  const topic1 = ethers.id(username.toLowerCase());
  const url =
    `${mirrorBaseUrl()}/api/v1/contracts/${contract}/results/logs?` +
    new URLSearchParams({
      order: "desc",
      limit: "1",
      topic0: PAGE_REGISTERED_TOPIC0,
      topic1,
    });
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { logs?: { timestamp?: string }[] };
    const ts = data.logs?.[0]?.timestamp;
    if (!ts) return null;
    const ms = Math.floor(Number(ts) * 1000);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Scan the forum topic for an existing referral record naming this
 * referred user. First referral wins — later attempts are rejected.
 */
async function findExistingReferral(
  deps: TownhallDeps,
  topic: string,
  referred: string,
): Promise<ReferralMessage | null> {
  const messages = await deps.hcs.queryAll(topic);
  for (const m of messages) {
    if (m.contents.kind !== "referral") continue;
    const c = m.contents as ReferralMessage;
    if (c.referred === referred) return c;
  }
  return null;
}

/**
 * Record who referred you. Called by the REFERRED user right after they
 * register their page (the client captures ?ref= into localStorage and
 * POSTs after successful on-chain registration).
 *
 * Auth: the signing wallet must own the referred username — you attest
 * your own referrer, nobody can claim credit for someone else's signup.
 * No dust fee — this is a system record, not user content. Per-wallet
 * daily quota still applies to bound operator-subsidized writes.
 *
 * Rules: referrer must be a registered username, referrer ≠ referred,
 * one referral per referred user (first wins), and the referred page
 * must have been registered within the last 7 days (mirror-node
 * PageRegistered event; fail-open when the mirror is unreachable).
 *
 * 201 → {seq}. Errors: 400 bad input / self-referral / duplicate /
 * too-old registration, 401 no session, 403 not the page owner /
 * referrer not registered, 429 quota exceeded.
 */
export async function recordReferral(
  deps: TownhallDeps,
  body: RecordReferralBody,
): Promise<HandlerResult> {
  const own = await requirePageOwner(deps, body, body.referredUsername, "referredUsername");
  if (!own.ok) return own.result;
  const referred = own.username.toLowerCase();
  const restricted = await requireNotRestricted(deps, own.session.address);
  if (restricted) return restricted;

  const rawReferrer = typeof body.referrer === "string" ? body.referrer.trim().toLowerCase() : "";
  if (!rawReferrer || !REFERRAL_USERNAME_RE.test(rawReferrer)) {
    return err(400, "referrer must be a valid Voicescape username");
  }
  if (rawReferrer === referred) {
    return err(400, "you cannot refer yourself");
  }
  let referrerRegistered = false;
  try {
    referrerRegistered = await deps.registry.isRegistered(rawReferrer);
  } catch {
    return err(503, "registry unavailable — try again in a moment");
  }
  if (!referrerRegistered) {
    return err(403, `referrer "${rawReferrer}" is not a registered Voicescape page`);
  }

  const topic = topicOr503("forum");
  if (typeof topic !== "string") return topic;

  const existing = await findExistingReferral(deps, topic, referred);
  if (existing) {
    return err(400, "a referral has already been recorded for this page");
  }

  // 7-day window: the referred page must be newly registered. Fail open
  // when the mirror node is unreachable (don't block growth on infra).
  const registeredAt = await pageRegisteredAt(referred);
  if (registeredAt !== null && Date.now() - registeredAt > REFERRAL_WINDOW_MS) {
    return err(400, "referral window expired — referrals must be recorded within 7 days of page registration");
  }

  const msg: ReferralMessage = {
    v: 1,
    kind: "referral",
    ts: new Date().toISOString(),
    author: own.username,
    referrer: rawReferrer,
    referred,
  };
  // Free path (no dust fee): bound operator-subsidized writes per wallet.
  const quota = await requireTownhallWriteQuota(own.session);
  if (quota) return quota;
  const seq = await deps.hcs.submit(topic, msg);
  return ok({ seq }, 201);
}

/**
 * Public referral stats for a user. Session-less read — anyone (including
 * external AI agents) can see who's driving growth.
 * 200 → {username, totalReferrals, referredUsernames[]} (oldest first).
 */
export async function getReferralStats(
  deps: TownhallDeps,
  username: string,
): Promise<HandlerResult> {
  const topic = topicOr503("forum");
  if (typeof topic !== "string") return topic;
  const name = username.trim().toLowerCase();
  if (!name) return err(400, "username is required");
  const messages = await deps.hcs.queryAll(topic);
  const referred: { username: string; ts: string }[] = [];
  for (const m of messages) {
    if (m.contents.kind !== "referral") continue;
    const c = m.contents as ReferralMessage;
    if (c.referrer !== name) continue;
    referred.push({ username: c.referred, ts: c.ts });
  }
  referred.sort((a, b) => a.ts.localeCompare(b.ts));
  const view: ReferralStatsView = {
    username: name,
    totalReferrals: referred.length,
    referredUsernames: referred.map((r) => r.username),
  };
  return ok(view);
}

/**
 * Collect every referral record (for badge derivation). Returns
 * referrer → count of referred users. Dedupe by referred user: first
 * record wins, matching the write-path rule.
 */
export function collectReferralCounts(messages: StoredMessage[]): Map<string, number> {
  const seenReferred = new Set<string>();
  const counts = new Map<string, number>();
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  for (const m of sorted) {
    if (m.contents.kind !== "referral") continue;
    const c = m.contents as ReferralMessage;
    if (!c.referrer || !c.referred) continue;
    if (seenReferred.has(c.referred)) continue;
    seenReferred.add(c.referred);
    const key = c.referrer.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/* Trending — what to promote                                         */
/* ------------------------------------------------------------------ */

export interface TrendingListing {
  id: string;
  title: string;
  priceUsdCents: number;
  sellerUsername: string | null;
  ts: string;
  url: string;
}

export interface TrendingRoom {
  id: string;
  title: string;
  description: string;
  /** Chat messages in the last 24h — the "heat" signal. */
  recentMessages: number;
}

export interface TrendingPage {
  username: string;
  /** ISO-8601 registration time from the PageRegistered event. */
  registeredAt: string;
}

export interface TrendingView {
  listings: TrendingListing[];
  rooms: TrendingRoom[];
  newPages: TrendingPage[];
  generatedAt: string;
}

const TRENDING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let trendingCache: { view: TrendingView; at: number } | null = null;
/** Test helper: reset the in-memory trending cache. */
export function clearTrendingCache(): void {
  trendingCache = null;
}

/**
 * What's hot on Voicescape right now — built for AI agents deciding what
 * to promote externally. Public, no auth. Cached 5 minutes.
 *
 * 200 → {listings: top 5 recent active listings, rooms: top 5 rooms by
 * 24h message volume, newPages: up to 5 pages registered in the last
 * 7 days (from on-chain PageRegistered events), generatedAt}.
 * Fail-open: any data source that errors is skipped, not fatal.
 */
export async function getTrending(
  deps: TownhallDeps,
  siteUrl: string,
): Promise<HandlerResult> {
  if (trendingCache && Date.now() - trendingCache.at < TRENDING_CACHE_TTL_MS) {
    return ok(trendingCache.view);
  }
  const view: TrendingView = {
    listings: [],
    rooms: [],
    newPages: [],
    generatedAt: new Date().toISOString(),
  };

  // 1. Trending listings: 5 most recent ACTIVE listings.
  try {
    const marketTopic = getTopicId("market");
    if (marketTopic) {
      const messages = await deps.hcs.queryAll(marketTopic);
      const latest = new Map<string, { msg: ListingMessage; seq: number }>();
      for (const m of messages) {
        if (m.contents.kind !== "listing") continue;
        const c = m.contents as ListingMessage;
        const prev = latest.get(c.id);
        if (!prev || m.seq > prev.seq) {
          latest.set(c.id, { msg: c, seq: m.seq });
        }
      }
      const active = [...latest.values()]
        .map((e) => e.msg)
        .filter((l) => l.status === "active")
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .slice(0, 5);
      view.listings = active.map((l) => ({
        id: l.id,
        title: l.title,
        priceUsdCents: l.priceUsdCents,
        sellerUsername: l.sellerUsername,
        ts: l.ts,
        url: `${siteUrl.replace(/\/$/, "")}/townhall/marketplace?listing=${encodeURIComponent(l.id)}`,
      }));
    }
  } catch {
    /* fail-open */
  }

  // 2. Active rooms: top 5 by chat messages in the last 24h.
  try {
    const chatTopic = getTopicId("chat");
    if (chatTopic) {
      const messages = await deps.hcs.queryAll(chatTopic);
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const counts = new Map<string, number>();
      const meta = new Map<string, { title: string; description: string }>();
      for (const m of messages) {
        const c = m.contents as { kind?: string; room?: string; id?: string; title?: string; description?: string; ts?: string };
        if (c.kind === "chatroom-create" && c.id) {
          meta.set(c.id, { title: c.title ?? c.id, description: c.description ?? "" });
        } else if (c.kind === "chat" && c.room) {
          const ts = Date.parse(c.ts ?? "");
          if (Number.isFinite(ts) && ts >= cutoff) {
            counts.set(c.room, (counts.get(c.room) ?? 0) + 1);
          }
        }
      }
      const ranked = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      view.rooms = ranked.map(([id, recentMessages]) => {
        const info = meta.get(id);
        return {
          id,
          title: info?.title ?? (id === "lobby" ? "🏠 Lobby" : `#${id}`),
          description: info?.description ?? "",
          recentMessages,
        };
      });
    }
  } catch {
    /* fail-open */
  }

  // 3. New pages: up to 5 PageRegistered events from the last 7 days.
  try {
    const contract = process.env.NEXT_PUBLIC_REGISTRY_ADDRESS?.trim();
    if (contract) {
      const url =
        `${mirrorBaseUrl()}/api/v1/contracts/${contract}/results/logs?` +
        new URLSearchParams({ order: "desc", limit: "100", topic0: PAGE_REGISTERED_TOPIC0 });
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as {
          logs?: { topics?: string[]; timestamp?: string; data?: string }[];
        };
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const seen = new Set<string>();
        for (const log of data.logs ?? []) {
          if (view.newPages.length >= 5) break;
          const tsRaw = log.timestamp;
          if (!tsRaw) continue;
          const ms = Math.floor(Number(tsRaw) * 1000);
          if (!Number.isFinite(ms) || ms < cutoff) continue;
          // topic1 = keccak256(username); decode via the event ABI when possible.
          // Fall back to skipping undecodable logs.
          try {
            const iface = new ethers.Interface([
              "event PageRegistered(string indexed username, address indexed owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
            ]);
            const parsed = iface.decodeEventLog("PageRegistered", log.data ?? "0x", log.topics ?? []);
            const username = String(parsed.username ?? "").toLowerCase();
            if (!username || seen.has(username)) continue;
            seen.add(username);
            view.newPages.push({
              username,
              registeredAt: new Date(ms).toISOString(),
            });
          } catch {
            /* undecodable log — skip */
          }
        }
      }
    }
  } catch {
    /* fail-open */
  }

  trendingCache = { view, at: Date.now() };
  return ok(view);
}
