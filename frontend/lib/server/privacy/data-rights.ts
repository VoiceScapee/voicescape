/**
 * Data-rights request log (GDPR / CCPA / other privacy rights).
 *
 * The Privacy Policy §8 promises every request gets an answer. Requests
 * are keyed to the requester's wallet address — no email, name, or other
 * new PII is collected (data minimization: the wallet is already the
 * platform's identity).
 *
 * Keys:
 *   privacy:req:<uuid>  → JSON request record (TTL 5 years)
 *   privacy:req-index   → JSON array of ids, newest first (TTL 5 years)
 */

import { randomUUID } from "crypto";
import { getKvStore } from "../store";
import { canonicalAddress } from "../../session-message";

const REQ_KEY_PREFIX = "privacy:req:";
const REQ_INDEX_KEY = "privacy:req-index";
const REQ_TTL_MS = 5 * 365 * 24 * 60 * 60 * 1000;

export type DataRightsKind = "access" | "correction" | "deletion" | "restriction";
export type DataRightsStatus = "pending" | "answered";

export interface DataRightsRequest {
  id: string;
  /** Canonical wallet address of the requester. */
  wallet: string;
  kind: DataRightsKind;
  details: string;
  receivedAt: string;
  status: DataRightsStatus;
  answeredAt?: string;
}

export function isDataRightsKind(v: unknown): v is DataRightsKind {
  return v === "access" || v === "correction" || v === "deletion" || v === "restriction";
}

/** Record a data-rights request. Throws on invalid input. */
export async function submitDataRightsRequest(
  wallet: string,
  kind: DataRightsKind,
  details: string,
): Promise<DataRightsRequest> {
  const canon = canonicalAddress(wallet);
  if (!canon) throw new Error("invalid wallet address");
  if (!isDataRightsKind(kind)) throw new Error("invalid request kind");
  const store = getKvStore();
  const req: DataRightsRequest = {
    id: randomUUID(),
    wallet: canon,
    kind,
    details: (details ?? "").slice(0, 2000),
    receivedAt: new Date().toISOString(),
    status: "pending",
  };
  await store.set(`${REQ_KEY_PREFIX}${req.id}`, JSON.stringify(req), REQ_TTL_MS);
  let index: string[] = [];
  try {
    index = JSON.parse((await store.get(REQ_INDEX_KEY)) ?? "[]");
    if (!Array.isArray(index)) index = [];
  } catch {
    index = [];
  }
  index.unshift(req.id);
  await store.set(REQ_INDEX_KEY, JSON.stringify(index.slice(0, 5000)), REQ_TTL_MS);
  console.warn(`[privacy] data-rights request ${req.id} (${kind}) from ${canon}`);
  return req;
}

/** Fetch one request (id format-guarded). */
export async function getDataRightsRequest(id: string): Promise<DataRightsRequest | null> {
  if (!id || /[^a-zA-Z0-9-]/.test(id)) return null;
  const raw = await getKvStore().get(`${REQ_KEY_PREFIX}${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DataRightsRequest;
  } catch {
    return null;
  }
}

/** List requests newest-first (founder view). */
export async function listDataRightsRequests(limit = 100): Promise<DataRightsRequest[]> {
  const raw = await getKvStore().get(REQ_INDEX_KEY);
  let index: string[] = [];
  try {
    index = JSON.parse(raw ?? "[]");
    if (!Array.isArray(index)) index = [];
  } catch {
    index = [];
  }
  const out: DataRightsRequest[] = [];
  for (const id of index.slice(0, Math.max(1, Math.min(500, limit)))) {
    const r = await getDataRightsRequest(id);
    if (r) out.push(r);
  }
  return out;
}

/** Mark a request answered (founder). */
export async function markDataRightsAnswered(id: string): Promise<DataRightsRequest | null> {
  const r = await getDataRightsRequest(id);
  if (!r) return null;
  r.status = "answered";
  r.answeredAt = new Date().toISOString();
  await getKvStore().set(`${REQ_KEY_PREFIX}${id}`, JSON.stringify(r), REQ_TTL_MS);
  return r;
}
