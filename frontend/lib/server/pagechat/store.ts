/**
 * Voicescape — native per-page chat storage.
 *
 * Each blockpage with a chat block gets its own room, keyed by the page's
 * (lowercased) username. Anyone can chat with a chosen username — no wallet
 * required. The page owner (wallet-verified against the on-chain registry)
 * and their promoted mods do the filtering: delete, mute, ban, word filters.
 *
 * Backed by the shared KvStore (Valkey → Upstash → memory), so it works on
 * every instance with zero new infrastructure. Messages are a capped JSON
 * array per room (last 100, 7-day rolling TTL) — casual page chat, not a
 * permanent record. Economics: $0 for the operator; spam is handled by
 * per-IP rate limits plus human mods, not fees.
 */

import type { KvStore } from "../store";
import { createHash } from "crypto";

/** What the API sends to browsers. Internal records also carry ipHash. */
export interface ChatMessage {
  id: number;
  /** Self-asserted display name (1–24 chars, sanitized). */
  name: string;
  body: string;
  ts: number;
  /** Canonical 0x wallet when the author chatted with a session, else null. */
  wallet: string | null;
}

interface StoredMessage extends ChatMessage {
  /** sha256(ip) — never exposed via the API; used for mute/ban matching. */
  ipHash: string;
}

export interface MuteEntry {
  /** "w:<0xaddr>" | "ip:<hex>" | "n:<lowercased name>" */
  target: string;
  expiresAtMs: number;
}

export interface BanEntry {
  target: string;
}

const PREFIX = "pagechat:v1";
const MAX_MESSAGES = 100;
const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const META_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 3000;

const kMsgs = (room: string) => `${PREFIX}:msgs:${room}`;
const kSeq = (room: string) => `${PREFIX}:seq:${room}`;
const kMods = (room: string) => `${PREFIX}:mods:${room}`;
const kMutes = (room: string) => `${PREFIX}:mutes:${room}`;
const kBans = (room: string) => `${PREFIX}:bans:${room}`;
const kFilters = (room: string) => `${PREFIX}:filters:${room}`;
const kLock = (room: string) => `${PREFIX}:lock:${room}`;

/** Room ids are page usernames: lowercase, tight charset. */
export function normalizeRoom(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const r = input.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,39}$/.test(r) ? r : null;
}

/** One-way IP fingerprint for mute/ban matching. Not a secret, not PII storage. */
export function hashIp(ip: string): string {
  return createHash("sha256").update(`pagechat|${ip}`).digest("hex").slice(0, 32);
}

function parseArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** Serialize with a best-effort lock so concurrent posters don't clobber each other. */
async function withRoomLock<T>(store: KvStore, room: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await store.setNx(kLock(room), "1", LOCK_TTL_MS)) {
      try {
        return await fn();
      } finally {
        await store.del(kLock(room)).catch(() => {});
      }
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("[pagechat] room busy — try again");
}

function toPublic(m: StoredMessage): ChatMessage {
  const { ipHash: _drop, ...pub } = m;
  return pub;
}

export async function getMessages(
  store: KvStore,
  room: string,
  sinceId = 0,
  limit = 100,
): Promise<ChatMessage[]> {
  const all = parseArray<StoredMessage>(await store.get(kMsgs(room)));
  return all
    .filter((m) => m.id > sinceId)
    .slice(-Math.max(1, Math.min(limit, MAX_MESSAGES)))
    .map(toPublic);
}

export async function getMessageById(
  store: KvStore,
  room: string,
  id: number,
): Promise<StoredMessage | null> {
  const all = parseArray<StoredMessage>(await store.get(kMsgs(room)));
  return all.find((m) => m.id === id) ?? null;
}

/** Append a message; returns its id. */
export async function appendMessage(
  store: KvStore,
  room: string,
  msg: { name: string; body: string; wallet: string | null; ipHash: string },
): Promise<number> {
  const id = await store.incr(kSeq(room), META_TTL_MS);
  const stored: StoredMessage = { id, ts: Date.now(), ...msg };
  await withRoomLock(store, room, async () => {
    const all = parseArray<StoredMessage>(await store.get(kMsgs(room)));
    all.push(stored);
    const trimmed = all.slice(-MAX_MESSAGES);
    await store.set(kMsgs(room), JSON.stringify(trimmed), ROOM_TTL_MS);
  });
  return id;
}

export async function deleteMessage(store: KvStore, room: string, id: number): Promise<boolean> {
  return withRoomLock(store, room, async () => {
    const all = parseArray<StoredMessage>(await store.get(kMsgs(room)));
    const kept = all.filter((m) => m.id !== id);
    if (kept.length === all.length) return false;
    await store.set(kMsgs(room), JSON.stringify(kept), ROOM_TTL_MS);
    return true;
  });
}

/* ------------------------------- mods ------------------------------- */

export async function getMods(store: KvStore, room: string): Promise<string[]> {
  return parseArray<string>(await store.get(kMods(room))).filter((a) => typeof a === "string");
}

export async function setMod(
  store: KvStore,
  room: string,
  address: string,
  promote: boolean,
): Promise<string[]> {
  return withRoomLock(store, room, async () => {
    const mods = new Set(await getMods(store, room));
    if (promote) mods.add(address);
    else mods.delete(address);
    const list = [...mods];
    await store.set(kMods(room), JSON.stringify(list), META_TTL_MS);
    return list;
  });
}

/* --------------------------- mutes & bans --------------------------- */

export async function getMutes(store: KvStore, room: string): Promise<MuteEntry[]> {
  const now = Date.now();
  const live = parseArray<MuteEntry>(await store.get(kMutes(room))).filter(
    (m) => m && typeof m.target === "string" && m.expiresAtMs > now,
  );
  return live;
}

export async function addMute(store: KvStore, room: string, target: string, ttlMs: number): Promise<MuteEntry[]> {
  return withRoomLock(store, room, async () => {
    const mutes = (await getMutes(store, room)).filter((m) => m.target !== target);
    mutes.push({ target, expiresAtMs: Date.now() + ttlMs });
    await store.set(kMutes(room), JSON.stringify(mutes), META_TTL_MS);
    return mutes;
  });
}

export async function removeMute(store: KvStore, room: string, target: string): Promise<MuteEntry[]> {
  return withRoomLock(store, room, async () => {
    const mutes = (await getMutes(store, room)).filter((m) => m.target !== target);
    await store.set(kMutes(room), JSON.stringify(mutes), META_TTL_MS);
    return mutes;
  });
}

export async function getBans(store: KvStore, room: string): Promise<BanEntry[]> {
  return parseArray<BanEntry>(await store.get(kBans(room))).filter(
    (b) => b && typeof b.target === "string",
  );
}

export async function addBan(store: KvStore, room: string, target: string): Promise<BanEntry[]> {
  return withRoomLock(store, room, async () => {
    const bans = (await getBans(store, room)).filter((b) => b.target !== target);
    bans.push({ target });
    await store.set(kBans(room), JSON.stringify(bans), META_TTL_MS);
    return bans;
  });
}

export async function removeBan(store: KvStore, room: string, target: string): Promise<BanEntry[]> {
  return withRoomLock(store, room, async () => {
    const bans = (await getBans(store, room)).filter((b) => b.target !== target);
    await store.set(kBans(room), JSON.stringify(bans), META_TTL_MS);
    return bans;
  });
}

/** True when any of the author's identities (wallet, ip, name) is muted/banned. */
export async function isMuted(
  store: KvStore,
  room: string,
  idents: { wallet: string | null; ipHash: string; name: string },
): Promise<boolean> {
  const targets = new Set<string>();
  if (idents.wallet) targets.add(`w:${idents.wallet}`);
  targets.add(`ip:${idents.ipHash}`);
  targets.add(`n:${idents.name.toLowerCase()}`);
  const mutes = await getMutes(store, room);
  return mutes.some((m) => targets.has(m.target));
}

export async function isBanned(
  store: KvStore,
  room: string,
  idents: { wallet: string | null; ipHash: string; name: string },
): Promise<boolean> {
  const targets = new Set<string>();
  if (idents.wallet) targets.add(`w:${idents.wallet}`);
  targets.add(`ip:${idents.ipHash}`);
  targets.add(`n:${idents.name.toLowerCase()}`);
  const bans = await getBans(store, room);
  return bans.some((b) => targets.has(b.target));
}

/* ----------------------------- word filter ----------------------------- */

export async function getFilters(store: KvStore, room: string): Promise<string[]> {
  return parseArray<string>(await store.get(kFilters(room))).filter((w) => typeof w === "string");
}

/** Whole-word match against the room's filtered words. */
export function hitsFilter(body: string, filters: string[]): boolean {
  if (filters.length === 0) return false;
  const words = new Set(body.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return filters.some((f) => words.has(f.toLowerCase()));
}

export async function setFilterWord(
  store: KvStore,
  room: string,
  word: string,
  add: boolean,
): Promise<string[]> {
  const clean = word.trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
  return withRoomLock(store, room, async () => {
    const filters = new Set(await getFilters(store, room));
    if (add && clean) filters.add(clean);
    if (!add) filters.delete(clean || word.trim().toLowerCase());
    const list = [...filters].slice(0, 100);
    await store.set(kFilters(room), JSON.stringify(list), META_TTL_MS);
    return list;
  });
}
