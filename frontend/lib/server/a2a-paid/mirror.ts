/**
 * Testnet mirror-node client for the paid endpoint prototype.
 *
 * Every function takes an explicit mirror base URL and asserts it is the
 * testnet node (never mainnet) before issuing a request. Field shapes below
 * were validated against the live testnet mirror node on 2026-09-15.
 */

import { assertTestnetMirror } from "./config";
import { toMirrorTxId } from "@/lib/tx-confirm";

export type FetchFn = typeof fetch;

export interface MirrorTransaction {
  result?: string;
  entity_id?: string;
  memo_base64?: string;
  transaction_id?: string;
  charged_tx_fee?: number;
}

export interface MirrorContractResult {
  status?: string;
  to?: string;
  amount?: string | number | null;
  function_parameters?: string;
  contract_id?: string;
}

async function getJson(
  mirrorBase: string,
  path: string,
  fetchFn: FetchFn,
): Promise<unknown | null> {
  assertTestnetMirror(mirrorBase);
  const res = await fetchFn(`${mirrorBase}${path}`, {
    headers: { "User-Agent": "VoicescapePaidPrototype/1.0" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`mirror_error: HTTP ${res.status} for ${path}`);
  return (await res.json()) as unknown;
}

/** Account balance in tinybars, or null when the account does not exist. */
export async function getAccountBalanceTinybar(
  mirrorBase: string,
  accountId: string,
  fetchFn: FetchFn = fetch,
): Promise<bigint | null> {
  const data = (await getJson(
    mirrorBase,
    `/accounts/${accountId}`,
    fetchFn,
  )) as { balance?: { balance?: number | string }; deleted?: boolean } | null;
  if (!data || data.deleted) return null;
  const raw = data.balance?.balance;
  if (raw === undefined || raw === null) return null;
  return BigInt(raw);
}

/** Transaction record, or null when not yet visible on the mirror node. */
export async function getMirrorTransaction(
  mirrorBase: string,
  txId: string,
  fetchFn: FetchFn = fetch,
): Promise<MirrorTransaction | null> {
  const data = (await getJson(
    mirrorBase,
    `/transactions/${toMirrorTxId(txId)}`,
    fetchFn,
  )) as { transactions?: MirrorTransaction[] } | null;
  return data?.transactions?.[0] ?? null;
}

/** Contract result for a transaction, or null when not yet available. */
export async function getMirrorContractResult(
  mirrorBase: string,
  txId: string,
  fetchFn: FetchFn = fetch,
): Promise<MirrorContractResult | null> {
  const data = (await getJson(
    mirrorBase,
    `/contracts/results/${toMirrorTxId(txId)}`,
    fetchFn,
  )) as MirrorContractResult | null;
  if (!data || typeof data !== "object") return null;
  return data;
}

/** Decode a mirror `memo_base64` field to utf8 (empty string when absent). */
export function decodeMemo(memoBase64: string | undefined | null): string {
  if (!memoBase64) return "";
  try {
    return Buffer.from(memoBase64, "base64").toString("utf8");
  } catch {
    return "";
  }
}
