/**
 * Voicescape Social Town Hall — moderator config + hide-filter logic.
 *
 * Trust model:
 *  - Global/board moderators come from the TOWNHALL_MODS env list
 *    (comma-separated registered usernames) and/or the TOWNHALL_MOD_WALLETS
 *    env list (comma-separated wallet addresses: Hedera account IDs like
 *    0.0.123 and/or EVM hex addresses). A mod wallet acts as a global mod
 *    with no page registration required; when it acts under a registered
 *    username the mod-action carries its wallet in `modWallet` so the
 *    session-less read path can still honor the hide.
 *  - Page owners moderate their own walls: a mod-action whose `wall` equals
 *    the author's username hides a post on that wall.
 *  - HCS authorship is the session-verified identity (every write route
 *    requires a signed wallet session, `requireSession`, plus page-ownership
 *    checks, `requirePageOwner` — except mod wallets, which authenticate by
 *    session wallet alone), so mod-actions are only honored from
 *    authorized moderators (or the wall owner). Wallet-signature
 *    verification of authorship is shipped, not a future item.
 *  - Hides target forum posts (targetKind "post", the default) or chat
 *    messages (targetKind "chat"; `board` carries the room name). A
 *    mod-action lives in the same HCS topic as its target.
 */

import type { ModActionMessage, PostView } from "./types";
import { canonicalAddress } from "../../session-message";

/**
 * Platform owner — the only account with mod access until the team scales.
 * Brandon's treasury wallet. Hardcoded intentionally: this is the bootstrap
 * phase, and mod access should not be broadly granted.
 */
const OWNER_WALLET = "0.0.10424063";
const OWNER_USERNAME = "user-10424063";
/**
 * Brandon's ECDSA-derived EVM address for 0.0.10424063 — proven on-chain
 * when he registered user-10424063 (registry owner =
 * 0x30C63DC43608B6764A6b8b53960553AEbF306817). NOTE: canonicalAddress()
 * maps 0.0.x to the LONG-ZERO 0x form, which never equals a wallet's
 * ECDSA-derived EVM address — so owner checks must compare against BOTH
 * forms. Never compare OWNER_WALLET via canonicalAddress alone.
 */
const OWNER_EVM = "0x30c63dc43608b6764a6b8b53960553aebf306817";

/**
 * True when the address belongs to the platform owner, in either address
 * form (Hedera 0.0.x / long-zero 0x, or the ECDSA-derived EVM address).
 */
export function isOwnerAddress(address: string | null | undefined): boolean {
  const c = address ? canonicalAddress(address) : null;
  if (!c) return false;
  return c === canonicalAddress(OWNER_WALLET) || c === OWNER_EVM;
}

export function getMods(): string[] {
  return (process.env.TOWNHALL_MODS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isMod(username: string): boolean {
  const name = username.toLowerCase();
  // Only the platform owner has mod access until the team scales
  if (name === OWNER_USERNAME) return true;
  return getMods().includes(name);
}

/**
 * Wallet-based global moderators: TOWNHALL_MOD_WALLETS, a comma-separated
 * list of Hedera account IDs (0.0.x) and/or EVM hex addresses. Entries are
 * canonicalized (0.0.x → long-zero 0x form; 0x… → lowercase) so either form
 * matches a session's canonical address; invalid or empty entries are
 * dropped.
 *
 * MOD_WALLET_ADDRESSES is honored as an alias of the same list, so the
 * moderation UI and the town-hall mod-action path agree on who is a mod.
 */
export function getModWallets(): string[] {
  const seen = new Set<string>();
  for (const raw of [process.env.TOWNHALL_MOD_WALLETS, process.env.MOD_WALLET_ADDRESSES]) {
    for (const s of (raw ?? "").split(",")) {
      const c = canonicalAddress(s.trim());
      if (c) seen.add(c);
    }
  }
  return [...seen];
}

export function isModWallet(address: string): boolean {
  const c = canonicalAddress(address);
  if (c === null) return false;
  // Only the platform owner has mod access until the team scales
  if (isOwnerAddress(address)) return true;
  return getModWallets().includes(c);
}

/**
 * Global-mod check across both identity paths: a TOWNHALL_MODS username or
 * a TOWNHALL_MOD_WALLETS wallet address. Pure — unit-testable.
 */
export function isGlobalMod(username: string, walletAddress?: string | null): boolean {
  return isMod(username) || (walletAddress ? isModWallet(walletAddress) : false);
}

/**
 * Is this mod-action authorized? Global/board mods (TOWNHALL_MODS usernames
 * or TOWNHALL_MOD_WALLETS wallets) may hide anywhere; a wall owner may hide
 * posts on their own wall. Wallet-mods acting under a username carry their
 * wallet in `modWallet` so the session-less read path honors the hide.
 */
export function isAuthorizedModAction(action: ModActionMessage): boolean {
  const mod = action.author.toLowerCase();
  if (isMod(action.author)) return true;
  if (isModWallet(action.author)) return true;
  if (action.modWallet && isModWallet(action.modWallet)) return true;
  if (action.wall && mod === action.wall.toLowerCase()) return true;
  return false;
}

interface HideScope {
  board: string | null;
  wall: string | null;
}

/**
 * Normalize a mod-action's target domain. Pre-existing mod-actions have no
 * targetKind — they were all forum-post hides, so "post" is the default.
 */
export function modActionTargetKind(a: ModActionMessage): "post" | "chat" {
  return a.targetKind === "chat" ? "chat" : "post";
}

/**
 * Build the set of hidden (scope, seq) pairs from mod-action messages.
 * Only authorized mod-actions are honored. Pure — unit-testable.
 */
export function hiddenSeqs(
  actions: ModActionMessage[],
  targetKind: "post" | "chat" = "post",
): Set<string> {
  const hidden = new Set<string>();
  for (const a of actions) {
    if (a.action !== "hide") continue;
    if (modActionTargetKind(a) !== targetKind) continue;
    if (!isAuthorizedModAction(a)) continue;
    const scope: HideScope = {
      board: a.board ? a.board.toLowerCase() : null,
      wall: a.wall ? a.wall.toLowerCase() : null,
    };
    hidden.add(`${targetKind}|${scope.board ?? "*"}|${scope.wall ?? "*"}|${a.targetSeq}`);
  }
  return hidden;
}

function hideKey(targetKind: "post" | "chat", board: string | null, wall: string | null, seq: number): string {
  return `${targetKind}|${board ?? "*"}|${wall ?? "*"}|${seq}`;
}

/**
 * Filter mod-hidden posts. A post is hidden when a matching authorized
 * hide targets its seq within its scope (board/wall fields, null wildcards).
 * Pure — unit-testable.
 */
export function filterHiddenPosts<T extends { seq: number; board: string; wall: string | null }>(
  posts: T[],
  actions: ModActionMessage[],
  targetKind: "post" | "chat" = "post",
): T[] {
  const hidden = hiddenSeqs(actions, targetKind);
  return posts.filter((p) => {
    const b = p.board.toLowerCase();
    const w = p.wall ? p.wall.toLowerCase() : null;
    return !(
      hidden.has(hideKey(targetKind, b, w, p.seq)) ||
      hidden.has(hideKey(targetKind, b, null, p.seq)) ||
      hidden.has(hideKey(targetKind, null, w, p.seq)) ||
      hidden.has(hideKey(targetKind, null, null, p.seq))
    );
  });
}

export type { PostView };
