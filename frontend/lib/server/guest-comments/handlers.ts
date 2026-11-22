/**
 * Voicescape — guest comments handlers (webseries blocks).
 *
 * No-login comments that persist for the next visitor. Handlers are
 * Next-agnostic and take injectable deps so they stay directly
 * unit-testable.
 *
 * Identity model (E10):
 * - Guests: self-asserted `name` + per-IP rate limits (route-level
 *   ipGate). Every guest comment is labelled Guest and carries no
 *   reputation/trust weight.
 * - Reserved names: a guest cannot post as a registered username. The
 *   check is two layers — a static blocklist for the prominent
 *   platform/page names, plus a live registry lookup (resolveOwner)
 *   that catches any other registered name while the mirror node is
 *   reachable. A registry null is ambiguous (unregistered OR outage),
 *   so it never blocks on its own; the static list is the floor.
 * - Owner: the on-chain registry owner of the page (same cryptographic
 *   binding the town hall uses) can hide a comment with a signed
 *   session. Hides are permanent in v1.
 *
 * Commenting is free (cost rule) and tipping still requires a wallet.
 */

import { canonicalAddress } from "../../session-message";
import { getKvStore, type KvStore } from "../store";
import { defaultAuthPort, type VerifyResult, type VerifiedSession } from "../townhall/auth";
import { defaultRegistryPort } from "../townhall/registry-check";
import {
  appendComment,
  getCommentById,
  getComments,
  hideComment,
  normalizePage,
  normalizeThread,
  type GuestComment,
} from "./store";

export interface GuestCommentsDeps {
  store: KvStore;
  registry: { resolveOwner(username: string): Promise<string | null> };
  auth: { verifySession(cred: unknown): Promise<VerifyResult> };
}

export function defaultGuestCommentsDeps(): GuestCommentsDeps {
  return {
    store: getKvStore(),
    registry: defaultRegistryPort(),
    auth: defaultAuthPort(),
  };
}

export type HandlerResult = { status: number; json: unknown };

const err = (status: number, error: string): HandlerResult => ({ status, json: { error } });

/**
 * Names a guest may never post as, even if unregistered: the platform
 * itself, staff-flavoured names, and the prominent pages whose
 * impersonation would mislead visitors. Any OTHER registered username is
 * caught by the live registry check in postGuestComment.
 */
export const RESERVED_GUEST_NAMES: ReadonlySet<string> = new Set([
  "voicescape",
  "voicescape-webseries",
  "admin",
  "support",
  "founder",
  "moderator",
  "mod",
  "system",
  "official",
  "team",
  "buddy",
  "blockpagebuddy",
  "danny",
  "thechomps",
  "informinmotion",
  "user-10424063",
  "forge",
  "echo",
]);

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
  deps: GuestCommentsDeps,
  auth: unknown,
): Promise<{ ok: true; address: string | null } | { ok: false; error: string }> {
  if (auth == null) return { ok: true, address: null };
  const v = await deps.auth.verifySession(auth);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, address: v.session.address };
}

/** Require a valid session. */
async function requireAddress(
  deps: GuestCommentsDeps,
  auth: unknown,
): Promise<{ ok: true; session: VerifiedSession } | { ok: false; result: HandlerResult }> {
  if (auth == null) return { ok: false, result: err(401, "sign in with your wallet first") };
  const v = await deps.auth.verifySession(auth);
  if (!v.ok) return { ok: false, result: err(401, v.error) };
  return { ok: true, session: v.session };
}

/** True when the address owns the page on-chain (registry is source of truth). */
async function isPageOwner(
  deps: GuestCommentsDeps,
  page: string,
  address: string,
): Promise<boolean> {
  let owner: string | null;
  try {
    owner = await deps.registry.resolveOwner(page);
  } catch {
    return false;
  }
  if (!owner) return false;
  try {
    return canonicalAddress(owner) === canonicalAddress(address);
  } catch {
    return owner.toLowerCase() === address.toLowerCase();
  }
}

export interface GuestCommentsList {
  comments: GuestComment[];
  /** True when the caller is signed in as the page owner (hide buttons). */
  canModerate: boolean;
}

export async function listGuestComments(
  deps: GuestCommentsDeps,
  pageInput: unknown,
  threadInput: unknown,
  auth?: unknown,
): Promise<HandlerResult> {
  const page = normalizePage(pageInput);
  const thread = normalizeThread(threadInput ?? "general");
  if (!page || !thread) return err(400, "unknown page or thread");
  const addr = await optionalAddress(deps, auth);
  if (!addr.ok) return err(401, addr.error);
  const comments = await getComments(deps.store, page, thread);
  const canModerate =
    addr.address !== null && (await isPageOwner(deps, page, addr.address));
  return { status: 200, json: { comments, canModerate } satisfies GuestCommentsList };
}

export async function postGuestComment(
  deps: GuestCommentsDeps,
  pageInput: unknown,
  threadInput: unknown,
  input: { name?: unknown; body?: unknown; parentId?: unknown },
): Promise<HandlerResult> {
  const page = normalizePage(pageInput);
  const thread = normalizeThread(threadInput ?? "general");
  if (!page || !thread) return err(400, "unknown page or thread");
  // Writes only land on registered pages (no room squatting — same rule
  // as pagechat). A null owner means unregistered or the registry is
  // unreachable; either way the write is refused, honestly.
  let pageOwner: string | null = null;
  try {
    pageOwner = await deps.registry.resolveOwner(page);
  } catch {
    pageOwner = null;
  }
  if (pageOwner === null) return err(404, "this page isn't registered on Voicescape");
  const name = validName(input.name);
  if (!name) return err(400, "a name is required (1–24 characters)");
  const body = validBody(input.body);
  if (!body) return err(400, "a comment is required (1–500 characters)");
  // Reserved names: static blocklist first, then the live registry.
  // resolveOwner returning null is ambiguous (unregistered or outage),
  // so only a positive hit rejects.
  if (RESERVED_GUEST_NAMES.has(name.toLowerCase())) {
    return err(409, "that name belongs to a page on Voicescape — pick another name");
  }
  let owner: string | null = null;
  try {
    owner = await deps.registry.resolveOwner(name.toLowerCase());
  } catch {
    owner = null;
  }
  if (owner !== null) {
    return err(409, "that name belongs to a registered page — pick another name");
  }
  // Replies must attach to a real comment in this thread.
  let parentId: number | null = null;
  if (input.parentId !== undefined && input.parentId !== null) {
    if (typeof input.parentId !== "number" || !Number.isInteger(input.parentId)) {
      return err(400, "reply target is invalid");
    }
    const parent = await getCommentById(deps.store, page, thread, input.parentId);
    if (!parent) return err(400, "reply target not found in this thread");
    parentId = input.parentId;
  }
  const id = await appendComment(deps.store, page, thread, { name, body, parentId });
  return { status: 201, json: { id } };
}

export async function hideGuestComment(
  deps: GuestCommentsDeps,
  pageInput: unknown,
  threadInput: unknown,
  idInput: unknown,
  auth: unknown,
): Promise<HandlerResult> {
  const page = normalizePage(pageInput);
  const thread = normalizeThread(threadInput ?? "general");
  if (!page || !thread) return err(400, "unknown page or thread");
  if (typeof idInput !== "number" || !Number.isInteger(idInput)) {
    return err(400, "a comment id is required");
  }
  const session = await requireAddress(deps, auth);
  if (!session.ok) return session.result;
  if (!(await isPageOwner(deps, page, session.session.address))) {
    return err(403, "only the page owner can hide comments");
  }
  const hidden = await hideComment(deps.store, page, thread, idInput);
  if (!hidden) return err(404, "comment not found");
  return { status: 200, json: { ok: true } };
}
