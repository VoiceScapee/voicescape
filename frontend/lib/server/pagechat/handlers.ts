/**
 * Voicescape — native per-page chat handlers.
 *
 * Anyone can chat with a chosen username (no wallet required); the page
 * owner and their promoted mods filter. Handlers are Next-agnostic and take
 * injectable deps so they stay directly unit-testable.
 *
 * Identity model:
 * - Chatters: self-asserted `name` + per-IP rate limits. A wallet session is
 *   OPTIONAL — when present the message is marked verified with the
 *   canonical address (and that address is what mods act on).
 * - Mods: wallet addresses promoted by the owner. Mod powers can't be
 *   spoofed by picking a username because acting requires a signed session
 *   for a listed address.
 * - Owner: the on-chain registry owner of the username (same cryptographic
 *   binding the town hall uses).
 */

import { canonicalAddress } from "../../session-message";
import { getKvStore, type KvStore } from "../store";
import { defaultAuthPort, type VerifyResult, type VerifiedSession } from "../townhall/auth";
import { defaultMirrorPort } from "../townhall/mirror";
import { defaultRegistryPort } from "../townhall/registry-check";
import {
  addBan,
  addMute,
  appendMessage,
  deleteMessage,
  getBans,
  getFilters,
  getMessageById,
  getMessages,
  getMods,
  getMutes,
  hashIp,
  hitsFilter,
  isBanned,
  isMuted,
  normalizeRoom,
  removeBan,
  removeMute,
  setFilterWord,
  setMod,
  type BanEntry,
  type ChatMessage,
  type MuteEntry,
} from "./store";

export interface PageChatDeps {
  store: KvStore;
  registry: { resolveOwner(username: string): Promise<string | null> };
  mirror: { resolveAccountId(address: string): Promise<string | null> };
  auth: { verifySession(cred: unknown): Promise<VerifyResult> };
}

export function defaultPageChatDeps(): PageChatDeps {
  return {
    store: getKvStore(),
    registry: defaultRegistryPort(),
    mirror: defaultMirrorPort(),
    auth: defaultAuthPort(),
  };
}

export type HandlerResult = { status: number; json: unknown };

const err = (status: number, error: string): HandlerResult => ({ status, json: { error } });

export type PageChatRole = "owner" | "mod" | "viewer";

/** Strip ASCII control chars, collapse whitespace. */
function cleanText(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
}

function validName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const n = cleanText(name).slice(0, 24);
  return n.length >= 1 ? n : null;
}

function validBody(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const b = cleanText(body).slice(0, 500);
  return b.length >= 1 ? b : null;
}

/** Verify an optional session. Returns the address or null (anonymous). */
async function optionalAddress(
  deps: PageChatDeps,
  auth: unknown,
): Promise<{ ok: true; address: string | null } | { ok: false; error: string }> {
  if (auth == null) return { ok: true, address: null };
  const v = await deps.auth.verifySession(auth);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, address: v.session.address };
}

/** Require a valid session. */
async function requireAddress(
  deps: PageChatDeps,
  auth: unknown,
): Promise<{ ok: true; session: VerifiedSession } | { ok: false; result: HandlerResult }> {
  if (auth == null) return { ok: false, result: err(401, "sign in with your wallet first") };
  const v = await deps.auth.verifySession(auth);
  if (!v.ok) return { ok: false, result: err(401, v.error) };
  return { ok: true, session: v.session };
}

/** True when the address owns the page on-chain (registry is source of truth). */
async function isPageOwner(
  deps: PageChatDeps,
  room: string,
  address: string,
): Promise<boolean> {
  let owner: string | null;
  try {
    owner = await deps.registry.resolveOwner(room);
  } catch {
    return false;
  }
  if (!owner) return false;
  try {
    const [ownerId, sessionId] = await Promise.all([
      deps.mirror.resolveAccountId(owner),
      deps.mirror.resolveAccountId(address),
    ]);
    if (ownerId && sessionId) return ownerId === sessionId;
  } catch {
    // fall through to canonical comparison
  }
  const ownerCanonical = canonicalAddress(owner);
  return !!ownerCanonical && ownerCanonical === address;
}

async function resolveRole(
  deps: PageChatDeps,
  room: string,
  address: string | null,
): Promise<PageChatRole> {
  if (!address) return "viewer";
  if (await isPageOwner(deps, room, address)) return "owner";
  const mods = await getMods(deps.store, room).catch(() => [] as string[]);
  return mods.includes(address) ? "mod" : "viewer";
}

/* --------------------------------- read --------------------------------- */

/** GET — public. Returns messages after `since`. */
export async function listPageChat(
  deps: PageChatDeps,
  roomInput: unknown,
  sinceInput: unknown,
): Promise<HandlerResult> {
  const room = normalizeRoom(roomInput);
  if (!room) return err(400, "unknown chat room");
  const since = typeof sinceInput === "number" && Number.isFinite(sinceInput) ? sinceInput : 0;
  try {
    const messages = await getMessages(deps.store, room, since);
    return { status: 200, json: { messages } };
  } catch {
    return err(503, "chat is unavailable right now — try again in a moment");
  }
}

/* --------------------------------- post --------------------------------- */

const POST_BURST_MS = 4000;
const POST_HOURLY_CAP = 120;

/**
 * POST — anyone with a username. Optional session attaches a verified
 * wallet. Per-IP burst + hourly caps; mutes/bans/filters enforced.
 */
export async function postPageChat(
  deps: PageChatDeps,
  roomInput: unknown,
  body: { name?: unknown; body?: unknown; auth?: unknown },
  ip: string,
): Promise<HandlerResult> {
  const room = normalizeRoom(roomInput);
  if (!room) return err(400, "unknown chat room");
  const name = validName(body.name);
  if (!name) return err(400, "pick a username (1–24 characters)");
  const text = validBody(body.body);
  if (!text) return err(400, "message can't be empty");
  if (!ip) return err(400, "missing network identity");

  // Room must belong to a registered page — no squatting on unregistered names.
  try {
    if (!(await deps.registry.resolveOwner(room))) {
      return err(404, "this page doesn't exist");
    }
  } catch {
    return err(503, "registry unavailable — try again in a moment");
  }

  const sess = await optionalAddress(deps, body.auth);
  if (!sess.ok) return err(401, sess.error);
  const wallet = sess.address;
  const ipHash = hashIp(ip);
  const idents = { wallet, ipHash, name };

  try {
    if (await isBanned(deps.store, room, idents)) return err(403, "you're banned from this chat");
    if (await isMuted(deps.store, room, idents))
      return err(403, "you're muted in this chat — try again later");
    if (hitsFilter(text, await getFilters(deps.store, room)))
      return err(400, "that message was blocked by this room's filters");

    // Per-IP rate limits: burst (setNx) in front of the hourly counter.
    const burstOk = await deps.store.setNx(
      `pagechat:v1:rlburst:${room}:${ipHash}`,
      "1",
      POST_BURST_MS,
    );
    if (!burstOk) return err(429, "slow down a little — try again in a bit");
    const hourly = await deps.store.incr(`pagechat:v1:rlhour:${room}:${ipHash}`, 3_600_000);
    if (hourly > POST_HOURLY_CAP) return err(429, "too many messages — try again later");

    const id = await appendMessage(deps.store, room, { name, body: text, wallet, ipHash });
    const message: ChatMessage = { id, name, body: text, ts: Date.now(), wallet };
    return { status: 201, json: { message } };
  } catch {
    return err(503, "chat is unavailable right now — try again in a moment");
  }
}

/* --------------------------------- role --------------------------------- */

/** GET role — who the caller is in this room (needs a session). */
export async function pageChatRole(
  deps: PageChatDeps,
  roomInput: unknown,
  auth: unknown,
): Promise<HandlerResult> {
  const room = normalizeRoom(roomInput);
  if (!room) return err(400, "unknown chat room");
  const s = await requireAddress(deps, auth);
  if (!s.ok) return s.result;
  try {
    const role = await resolveRole(deps, room, s.session.address);
    const json: Record<string, unknown> = { role, address: s.session.address };
    if (role !== "viewer") {
      const [mods, mutes, bans, filters] = await Promise.all([
        getMods(deps.store, room),
        getMutes(deps.store, room),
        getBans(deps.store, room),
        getFilters(deps.store, room),
      ]);
      json.mods = mods;
      json.mutes = mutes;
      json.bans = bans;
      json.filters = filters;
    }
    return { status: 200, json };
  } catch {
    return err(503, "chat is unavailable right now — try again in a moment");
  }
}

/* -------------------------------- moderate ------------------------------- */

export type ModAction =
  | "delete"
  | "mute"
  | "unmute"
  | "ban"
  | "unban"
  | "promote"
  | "demote"
  | "filter-add"
  | "filter-remove";

const MUTE_TTL_MS = 10 * 60 * 1000;

/**
 * POST moderate — mod powers need a session; promote/demote/filter-manage
 * need the owner. Targets resolve from a message id (mod acts on the
 * author's wallet when verified, else their IP + name).
 */
export async function moderatePageChat(
  deps: PageChatDeps,
  roomInput: unknown,
  body: { action?: unknown; messageId?: unknown; target?: unknown; word?: unknown; auth?: unknown },
  ip: string,
): Promise<HandlerResult> {
  const room = normalizeRoom(roomInput);
  if (!room) return err(400, "unknown chat room");
  const s = await requireAddress(deps, body.auth);
  if (!s.ok) return s.result;
  const action = body.action as ModAction;
  const validActions: ModAction[] = [
    "delete",
    "mute",
    "unmute",
    "ban",
    "unban",
    "promote",
    "demote",
    "filter-add",
    "filter-remove",
  ];
  if (!validActions.includes(action)) return err(400, "unknown moderation action");

  try {
    const role = await resolveRole(deps, room, s.session.address);
    if (role === "viewer") return err(403, "only this page's owner and mods can do that");
    const ownerOnly: ModAction[] = ["promote", "demote"];
    if (ownerOnly.includes(action) && role !== "owner")
      return err(403, "only the page owner can manage mods");

    // Resolve the target identity from a message when one is given.
    let targetWallet: string | null = null;
    let targetIpHash: string | null = null;
    let targetName: string | null = null;
    if (typeof body.messageId === "number") {
      const msg = await getMessageById(deps.store, room, body.messageId);
      if (!msg) return err(404, "message not found");
      targetWallet = msg.wallet;
      targetIpHash = (msg as { ipHash?: string }).ipHash ?? null;
      targetName = msg.name;
    } else if (typeof body.target === "string") {
      const t = body.target.trim();
      const canon = canonicalAddress(t);
      if (canon) targetWallet = canon;
      else if (t) targetName = cleanText(t).slice(0, 24).toLowerCase() || null;
    }

    const targets: string[] = [];
    if (targetWallet) targets.push(`w:${targetWallet}`);
    if (targetIpHash) targets.push(`ip:${targetIpHash}`);
    if (targetName) targets.push(`n:${targetName}`);

    let mods: string[] | undefined;
    let mutes: MuteEntry[] | undefined;
    let bans: BanEntry[] | undefined;
    let filters: string[] | undefined;

    switch (action) {
      case "delete": {
        if (typeof body.messageId !== "number") return err(400, "messageId is required");
        const ok = await deleteMessage(deps.store, room, body.messageId);
        if (!ok) return err(404, "message not found");
        break;
      }
      case "mute": {
        if (targets.length === 0) return err(400, "nothing to mute");
        for (const t of targets) mutes = await addMute(deps.store, room, t, MUTE_TTL_MS);
        break;
      }
      case "unmute": {
        if (targets.length === 0) return err(400, "nothing to unmute");
        for (const t of targets) mutes = await removeMute(deps.store, room, t);
        break;
      }
      case "ban": {
        if (targets.length === 0) return err(400, "nothing to ban");
        for (const t of targets) bans = await addBan(deps.store, room, t);
        break;
      }
      case "unban": {
        if (targets.length === 0) return err(400, "nothing to unban");
        for (const t of targets) bans = await removeBan(deps.store, room, t);
        break;
      }
      case "promote":
      case "demote": {
        // Mods are wallet addresses only — promoting needs a verified wallet
        // so nobody can claim mod powers by picking a username.
        const addr = targetWallet ?? (typeof body.target === "string" ? canonicalAddress(body.target.trim()) : null);
        if (!addr) return err(400, "promoting needs the person's wallet address — ask them to chat once with their wallet connected");
        mods = await setMod(deps.store, room, addr, action === "promote");
        break;
      }
      case "filter-add":
      case "filter-remove": {
        if (typeof body.word !== "string" || !body.word.trim())
          return err(400, "a word is required");
        filters = await setFilterWord(deps.store, room, body.word, action === "filter-add");
        break;
      }
    }

    const json: Record<string, unknown> = { ok: true };
    // Refresh the mod panel state for the UI.
    const [rMods, rMutes, rBans, rFilters] = await Promise.all([
      mods ?? getMods(deps.store, room),
      mutes ?? getMutes(deps.store, room),
      bans ?? getBans(deps.store, room),
      filters ?? getFilters(deps.store, room),
    ]);
    json.mods = rMods;
    json.mutes = rMutes;
    json.bans = rBans;
    json.filters = rFilters;
    return { status: 200, json };
  } catch {
    return err(503, "chat is unavailable right now — try again in a moment");
  }
}
