/**
 * DMCA notice + counter-notice intake log.
 *
 * §512(c) safe harbor requires expeditious removal on a compliant notice,
 * uploader notification, and counter-notice restoration in 10–14 business
 * days absent a lawsuit. This module records every notice with a timestamp
 * so the takedown workflow is auditable.
 *
 * Two intake channels exist today:
 *  1. The on-site form at /dmca (stored here, in the shared KV store).
 *  2. The Discord #customer-support channel (existing; a moderator copies
 *     it in via the admin route).
 *
 * Designated-agent contact comes from DMCA_AGENT_CONTACT (env). Until
 * Brandon registers the official agent with the Copyright Office, it
 * defaults to the existing Discord #customer-support channel.
 *
 * Keys:
 *   dmca:notice:<uuid>  → JSON notice record (TTL 10 years)
 *   dmca:notice-index   → JSON array of ids, newest first (TTL 10 years)
 *
 * Privacy: a DMCA notice BY LAW must include the reporter's identity and
 * contact info — that PII is kept here, never published, and disclosed in
 * the Privacy Policy §2 (DMCA notices).
 */

import { randomUUID } from "crypto";
import { getKvStore } from "../store";
import { canonicalAddress } from "../../session-message";

const NOTICE_KEY_PREFIX = "dmca:notice:";
const NOTICE_INDEX_KEY = "dmca:notice-index";
/** 10 years in ms — the notice log is the audit trail; it is never pruned. */
const NOTICE_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export type DmcaNoticeKind = "notice" | "counter-notice";
export type DmcaNoticeStatus = "pending" | "actioned" | "dismissed";

export interface DmcaNoticeInput {
  kind: DmcaNoticeKind;
  /** Description of the copyrighted work. */
  work: string;
  /** Where the material is on Voicescape (URL). */
  location: string;
  /** Reporter's name. */
  contactName: string;
  /** Reporter's email or other contact. */
  contact: string;
  /** The wallet the material is attributed to, if known. */
  reportedWallet?: string;
  /** Good-faith belief the use is unauthorized. */
  goodFaith: boolean;
  /** Penalty-of-perjury accuracy statement (required for notices). */
  perjuryStatement?: boolean;
  /** The reporter's signature (typed name). */
  signature: string;
}

export interface DmcaNotice extends DmcaNoticeInput {
  id: string;
  /** ISO-8601 receipt timestamp — starts the expeditious-removal clock. */
  receivedAt: string;
  status: DmcaNoticeStatus;
  statusBy?: string;
  statusAt?: string;
  /** Source channel: "site" | "discord". */
  source: "site" | "discord";
}

export interface ValidationError {
  field: string;
  message: string;
}

/** Validate a notice submission; returns the list of problems (empty = valid). */
export function validateNotice(input: Partial<DmcaNoticeInput>): ValidationError[] {
  const errs: ValidationError[] = [];
  const need = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (input.kind !== "notice" && input.kind !== "counter-notice")
    errs.push({ field: "kind", message: "kind must be 'notice' or 'counter-notice'" });
  if (!need(input.work)) errs.push({ field: "work", message: "describe the copyrighted work" });
  if (!need(input.location))
    errs.push({ field: "location", message: "tell us where the material is (a link is enough)" });
  if (!need(input.contactName)) errs.push({ field: "contactName", message: "your name is required" });
  if (!need(input.contact))
    errs.push({ field: "contact", message: "a way to reach you is required" });
  if (!need(input.signature))
    errs.push({ field: "signature", message: "sign with your typed name" });
  if (input.goodFaith !== true)
    errs.push({
      field: "goodFaith",
      message: "you must confirm you believe in good faith the use is unauthorized",
    });
  if (input.kind === "notice" && input.perjuryStatement !== true)
    errs.push({
      field: "perjuryStatement",
      message: "a notice must include the penalty-of-perjury accuracy statement",
    });
  if (
    input.reportedWallet !== undefined &&
    input.reportedWallet !== "" &&
    !canonicalAddress(input.reportedWallet)
  )
    errs.push({ field: "reportedWallet", message: "reported wallet must be a Hedera account id or 0x address" });
  return errs;
}

/** Record a validated notice. Throws on invalid input. */
export async function submitNotice(
  input: DmcaNoticeInput,
  source: "site" | "discord" = "site",
): Promise<DmcaNotice> {
  const errs = validateNotice(input);
  if (errs.length) throw new Error(`invalid notice: ${errs.map((e) => e.field).join(", ")}`);
  const store = getKvStore();
  const notice: DmcaNotice = {
    ...input,
    reportedWallet: input.reportedWallet?.trim() || undefined,
    id: randomUUID(),
    receivedAt: new Date().toISOString(),
    status: "pending",
    source,
  };
  await store.set(`${NOTICE_KEY_PREFIX}${notice.id}`, JSON.stringify(notice), NOTICE_TTL_MS);
  let index: string[] = [];
  try {
    index = JSON.parse((await store.get(NOTICE_INDEX_KEY)) ?? "[]");
    if (!Array.isArray(index)) index = [];
  } catch {
    index = [];
  }
  index.unshift(notice.id);
  await store.set(NOTICE_INDEX_KEY, JSON.stringify(index.slice(0, 5000)), NOTICE_TTL_MS);
  console.warn(`[dmca] ${notice.kind} ${notice.id} received from ${source} at ${notice.receivedAt}`);
  return notice;
}

/** Fetch one notice by id. */
export async function getNotice(id: string): Promise<DmcaNotice | null> {
  if (!id || /[^a-zA-Z0-9-]/.test(id)) return null;
  const raw = await getKvStore().get(`${NOTICE_KEY_PREFIX}${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DmcaNotice;
  } catch {
    return null;
  }
}

/** List notices newest-first (admin view). Caps at `limit`. */
export async function listNotices(limit = 100): Promise<DmcaNotice[]> {
  const raw = await getKvStore().get(NOTICE_INDEX_KEY);
  let index: string[] = [];
  try {
    index = JSON.parse(raw ?? "[]");
    if (!Array.isArray(index)) index = [];
  } catch {
    index = [];
  }
  const out: DmcaNotice[] = [];
  for (const id of index.slice(0, Math.max(1, Math.min(500, limit)))) {
    const n = await getNotice(id);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Update a notice's status. When a notice is "actioned" as a takedown and
 * names a wallet, the caller records the copyright strike (see
 * app/api/dmca/admin/route.ts) — one strike per executed takedown.
 */
export async function setNoticeStatus(
  id: string,
  status: DmcaNoticeStatus,
  statusBy: string,
): Promise<DmcaNotice | null> {
  const notice = await getNotice(id);
  if (!notice) return null;
  notice.status = status;
  notice.statusBy = statusBy;
  notice.statusAt = new Date().toISOString();
  await getKvStore().set(`${NOTICE_KEY_PREFIX}${id}`, JSON.stringify(notice), NOTICE_TTL_MS);
  return notice;
}

/** Designated-agent contact, from env; defaults to Discord until the official agent is registered. */
export function getDmcaAgentContact(): string {
  const raw = (process.env.DMCA_AGENT_CONTACT ?? "").trim();
  return raw || "Discord #customer-support (Voicescape server)";
}
