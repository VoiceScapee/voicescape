/**
 * Wallet-signed follows — pure, framework-free core shared by the API
 * routes and unit tests.
 *
 * Storage layout (string KV values, JSON arrays):
 *   follows:<wallet-lowercase>   → ["alice","bob"]   (private: only the
 *                                            wallet's own session may read)
 *   followers:<username>         → ["0xabc…","0xdef…"] (public follower
 *                                            count; wallets are the only
 *                                            identifier Voicescape stores)
 *
 * Follows are wallet-signed: every write requires a verified session and
 * the follower is always the session's wallet address. Voicescape never
 * holds funds — following is free and moves no value.
 */

/** Minimal string store surface — KvStore satisfies this. */
export interface FollowStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** Minimal registry surface — the real port is in lib/server/townhall/registry-check. */
export interface FollowRegistry {
  /**
   * The page owner's address in EVM 0x… form plus the on-chain owner type,
   * or null when the username is not registered. Null on any read failure
   * is treated as unknown — the caller must not mistake an outage for an
   * unregistered name (the route turns this into a 503, not a 404).
   */
  resolvePage(username: string): Promise<{ owner: string; ownerType: 0 | 1 } | null>;
}

/** Follows persist for a year; every write refreshes the TTL. */
export const FOLLOWS_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Usernames are the on-chain registry's shape: lowercase, 3–32 chars. */
export const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;

export function followsKey(wallet: string): string {
  return `follows:${wallet.trim().toLowerCase()}`;
}

export function followersKey(username: string): string {
  return `followers:${username.trim().toLowerCase()}`;
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/** The caller's own following list (normalized, deduped, insertion-ordered). */
export async function readFollowList(store: FollowStore, wallet: string): Promise<string[]> {
  return parseStringArray(await store.get(followsKey(wallet)));
}

/** Public follower count for a page. */
export async function followerCount(store: FollowStore, username: string): Promise<number> {
  return parseStringArray(await store.get(followersKey(username))).length;
}

async function writeFollowList(store: FollowStore, wallet: string, list: string[]): Promise<void> {
  await store.set(followsKey(wallet), JSON.stringify(list), FOLLOWS_TTL_MS);
}

async function writeFollowers(store: FollowStore, username: string, wallets: string[]): Promise<void> {
  await store.set(followersKey(username), JSON.stringify(wallets), FOLLOWS_TTL_MS);
}

export type FollowError = "invalid-username" | "unknown-username" | "self-follow";

export type FollowResult =
  | { ok: true; following: string[] }
  | { ok: false; error: FollowError };

export interface FollowArgs {
  store: FollowStore;
  /** Session wallet address (any form — normalized internally). */
  wallet: string;
  /** Page username the wallet wants to follow. */
  username: string;
  registry: FollowRegistry;
}

/**
 * Follow a page. Validates the username, resolves it on-chain (404 when
 * unknown), rejects self-follows, and dedupes repeat follows.
 */
export async function followPage(args: FollowArgs): Promise<FollowResult> {
  const { store, registry } = args;
  const username = args.username.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) return { ok: false, error: "invalid-username" };

  const page = await registry.resolvePage(username);
  if (!page) return { ok: false, error: "unknown-username" };

  const me = args.wallet.trim().toLowerCase();
  if (page.owner.trim().toLowerCase() === me) return { ok: false, error: "self-follow" };

  const following = await readFollowList(store, me);
  if (!following.includes(username)) {
    following.push(username);
    await writeFollowList(store, me, following);
    const followers = parseStringArray(await store.get(followersKey(username)));
    if (!followers.includes(me)) {
      followers.push(me);
      await writeFollowers(store, username, followers);
    }
  } else {
    // Still refresh the TTL so an active follower never silently expires.
    await writeFollowList(store, me, following);
  }
  return { ok: true, following };
}

/** Unfollow a page. Idempotent — unfollowing twice is not an error. */
export async function unfollowPage(
  store: FollowStore,
  wallet: string,
  username: string,
): Promise<string[]> {
  const me = wallet.trim().toLowerCase();
  const name = username.trim().toLowerCase();
  const following = (await readFollowList(store, me)).filter((u) => u !== name);
  await writeFollowList(store, me, following);
  const followers = parseStringArray(await store.get(followersKey(name))).filter((w) => w !== me);
  await writeFollowers(store, name, followers);
  return following;
}

/* ------------------------------------------------------------------ */
/* Chronological digest: pure merge, newest first.                     */
/* ------------------------------------------------------------------ */

/**
 * One digest row. Tips come from mirror-node TipSent events (proven
 * on-chain); posts come from the Town Hall forum. `tsMs` is epoch
 * milliseconds — the merge sorts on it only.
 */
export type DigestItem =
  | {
      kind: "tip";
      username: string;
      ownerType: "human" | "agent";
      from: string;
      amountHbar: number;
      tsMs: number;
      txLink: string | null;
    }
  | {
      kind: "post";
      username: string;
      ownerType: "human" | "agent";
      board: string;
      body: string;
      tsMs: number;
    };

/**
 * Merge digest rows newest-first. No ranking, no algorithmic ordering —
 * strictly chronological. Stable: equal timestamps keep insertion order.
 */
export function mergeDigestItems(items: DigestItem[]): DigestItem[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => b.item.tsMs - a.item.tsMs || a.i - b.i)
    .map(({ item }) => item);
}

/** Pad an EVM address to a 32-byte topic for mirror-node topic filters. */
export function padTopicAddress(evmAddress: string): string {
  const hex = evmAddress.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error("padTopicAddress: not an EVM address");
  return `0x${"0".repeat(24)}${hex}`;
}
