/**
 * Voicescape — guest comments storage (webseries blocks).
 *
 * One discussion thread per (page, thread): "ep1" for per-episode
 * comments, "discuss" for the general wall, "intros" for introductions.
 * No wallet required — guests post with a self-asserted name. The page
 * owner can hide a comment (server-enforced, signed session); hides are
 * the only moderation in v1, alongside rate limits + reserved names in
 * the handler layer.
 *
 * Backed by the shared KvStore (Valkey → Upstash → memory), so it works
 * on every instance with zero new infrastructure. Comments are a capped
 * JSON array per thread (last 200, 90-day rolling TTL) — page content,
 * not a permanent record. Same storage pattern as pagechat.
 */

import type { KvStore } from "../store";

/** What the API sends to browsers. */
export interface GuestComment {
  id: number;
  /** Self-asserted display name (1–24 chars, sanitized). Guests are labelled Guest. */
  name: string;
  body: string;
  /** Null for a top-level comment, otherwise the id of the comment it replies to. */
  parentId: number | null;
  ts: number;
}

interface StoredGuestComment extends GuestComment {
  hidden: boolean;
}

const PREFIX = "guest-comments:v1";
const MAX_COMMENTS = 200;
const THREAD_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 3000;

const kComments = (page: string, thread: string) => `${PREFIX}:comments:${page}:${thread}`;
const kSeq = (page: string, thread: string) => `${PREFIX}:seq:${page}:${thread}`;
const kLock = (page: string, thread: string) => `${PREFIX}:lock:${page}:${thread}`;

/** Page usernames and thread slugs: lowercase, tight charset. */
export function normalizePage(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const p = input.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(p) ? p : null;
}

export function normalizeThread(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(t) ? t : null;
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
async function withThreadLock<T>(
  store: KvStore,
  page: string,
  thread: string,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await store.setNx(kLock(page, thread), "1", LOCK_TTL_MS)) {
      try {
        return await fn();
      } finally {
        await store.del(kLock(page, thread)).catch(() => {});
      }
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("[guest-comments] thread busy — try again");
}

function toPublic(c: StoredGuestComment): GuestComment {
  const { hidden: _drop, ...pub } = c;
  return pub;
}

export async function getComments(
  store: KvStore,
  page: string,
  thread: string,
): Promise<GuestComment[]> {
  const all = parseArray<StoredGuestComment>(await store.get(kComments(page, thread)));
  return all.filter((c) => !c.hidden).map(toPublic);
}

export async function getCommentById(
  store: KvStore,
  page: string,
  thread: string,
  id: number,
): Promise<StoredGuestComment | null> {
  const all = parseArray<StoredGuestComment>(await store.get(kComments(page, thread)));
  return all.find((c) => c.id === id) ?? null;
}

/** Append a comment; returns its id. */
export async function appendComment(
  store: KvStore,
  page: string,
  thread: string,
  comment: { name: string; body: string; parentId: number | null },
): Promise<number> {
  const id = await store.incr(kSeq(page, thread), THREAD_TTL_MS);
  const stored: StoredGuestComment = { id, ts: Date.now(), hidden: false, ...comment };
  await withThreadLock(store, page, thread, async () => {
    const all = parseArray<StoredGuestComment>(await store.get(kComments(page, thread)));
    all.push(stored);
    const trimmed = all.slice(-MAX_COMMENTS);
    await store.set(kComments(page, thread), JSON.stringify(trimmed), THREAD_TTL_MS);
  });
  return id;
}

/** Hide a comment (owner moderation). Returns false when the id is unknown. */
export async function hideComment(
  store: KvStore,
  page: string,
  thread: string,
  id: number,
): Promise<boolean> {
  return withThreadLock(store, page, thread, async () => {
    const all = parseArray<StoredGuestComment>(await store.get(kComments(page, thread)));
    const target = all.find((c) => c.id === id);
    if (!target || target.hidden) return false;
    target.hidden = true;
    await store.set(kComments(page, thread), JSON.stringify(all), THREAD_TTL_MS);
    return true;
  });
}
