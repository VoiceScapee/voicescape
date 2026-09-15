/**
 * Payment claim: POST /api/a2a/paid
 *
 * The buyer hands us { orderId, txId } after paying via tipPage. We verify
 * against the TESTNET mirror node and, only when EVERY check holds, mark the
 * order paid exactly once and return the entitlement.
 *
 * Verification rules (all must hold — never half-accept):
 *  - tx result == SUCCESS (poll up to ~60s for mirror visibility)
 *  - tx entity_id == the configured testnet Tips contract
 *  - tx memo contains the exact order-bound memo (vs-order:<orderId>)
 *  - contract result status == 0x1, `to` == Tips contract,
 *    function selector == tipPage, amount >= price
 *  - the tipPage username argument == the order's recipientUsername
 *    (Brandon's rule 2026-09-15: builder revenue goes to HIS wallet —
 *    a payment to any other username is rejected, never re-routed)
 *  - txId never claimed before (idempotency key)
 */

import {
  TIP_PAGE_SELECTOR,
  getPaidConfig,
  hbarToTinybar,
  normalizeToAccountId,
  type PaidConfig,
} from "./config";
import {
  decodeMemo,
  getMirrorContractResult,
  getMirrorTransaction,
  type FetchFn,
} from "./mirror";
import {
  getOrder,
  isOrderExpired,
  isTxClaimed,
  markOrderPaid,
  type Entitlement,
} from "./store";

export interface ClaimInput {
  orderId: string;
  txId: string;
}

export type ClaimErrorCode =
  | "order_not_found"
  | "order_not_payable"
  | "order_expired"
  | "already_claimed"
  | "tx_failed"
  | "wrong_contract"
  | "memo_mismatch"
  | "wrong_function"
  | "wrong_recipient"
  | "underpaid"
  | "verification_timeout"
  | "misconfigured";

export interface ClaimError {
  code: ClaimErrorCode;
  detail?: string;
}

export interface ClaimDeps {
  fetchFn?: FetchFn;
  now?: () => number;
  env?: Record<string, string | undefined>;
  /** Poll attempts (default 12). */
  attempts?: number;
  /** ms between polls (default 5000 → ~60s total). */
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Decode the single `string` argument of tipPage(string) from the mirror
 * node's hex function_parameters (selector + ABI-encoded string).
 * Returns null when the calldata is malformed. Hand-decoded with Buffer —
 * no new dependencies.
 */
export function decodeTipPageUsername(
  functionParameters: string | undefined,
): string | null {
  if (!functionParameters) return null;
  const hex = functionParameters.startsWith("0x")
    ? functionParameters.slice(2)
    : functionParameters;
  // selector (8 hex chars) + offset word (64) + length word (64) + data
  if (hex.length < 8 + 64 + 64) return null;
  const body = hex.slice(8);
  const offset = parseInt(body.slice(0, 64), 16);
  // A single string argument must sit at offset 32.
  if (offset !== 32) return null;
  const len = parseInt(body.slice(64, 128), 16);
  if (!Number.isSafeInteger(len) || len <= 0 || len > 256) return null;
  const dataHex = body.slice(128, 128 + len * 2);
  if (dataHex.length !== len * 2) return null;
  try {
    return Buffer.from(dataHex, "hex").toString("utf8");
  } catch {
    return null;
  }
}

export async function claimPayment(
  input: ClaimInput,
  deps: ClaimDeps = {},
): Promise<{ ok: true; entitlement: Entitlement } | { ok: false; error: ClaimError }> {
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;
  const attempts = deps.attempts ?? 12;
  const intervalMs = deps.intervalMs ?? 5000;
  const sleep = deps.sleep ?? defaultSleep;

  let config: PaidConfig;
  try {
    config = getPaidConfig(deps.env);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "misconfigured",
        detail: e instanceof Error ? e.message : String(e),
      },
    };
  }

  const orderId = (input.orderId ?? "").trim();
  const txId = (input.txId ?? "").trim();
  if (!orderId || !txId) {
    return { ok: false, error: { code: "order_not_found" } };
  }

  if (isTxClaimed(txId)) {
    return { ok: false, error: { code: "already_claimed" } };
  }

  const order = getOrder(orderId);
  if (!order) return { ok: false, error: { code: "order_not_found" } };
  if (order.state !== "issued") {
    return { ok: false, error: { code: "order_not_payable", detail: order.state } };
  }
  if (isOrderExpired(order, now())) {
    return { ok: false, error: { code: "order_expired" } };
  }

  const requiredTinybar = hbarToTinybar(order.priceHbar);
  let lastError: ClaimError = { code: "verification_timeout" };

  for (let attempt = 0; attempt < attempts; attempt++) {
    let tx: Awaited<ReturnType<typeof getMirrorTransaction>>;
    let cr: Awaited<ReturnType<typeof getMirrorContractResult>>;
    try {
      [tx, cr] = await Promise.all([
        getMirrorTransaction(config.mirrorBase, txId, fetchFn),
        getMirrorContractResult(config.mirrorBase, txId, fetchFn),
      ]);
    } catch {
      lastError = { code: "verification_timeout", detail: "mirror_error" };
      if (attempt < attempts - 1) await sleep(intervalMs);
      continue;
    }

    if (!tx) {
      lastError = { code: "verification_timeout", detail: "tx_not_visible" };
      if (attempt < attempts - 1) await sleep(intervalMs);
      continue;
    }

    // Transaction record checks — decisive, no retry.
    if (tx.result !== "SUCCESS") {
      return { ok: false, error: { code: "tx_failed", detail: tx.result ?? "unknown" } };
    }
    if (tx.entity_id !== config.tipsAccountId) {
      return {
        ok: false,
        error: { code: "wrong_contract", detail: tx.entity_id ?? "unknown" },
      };
    }
    const memo = decodeMemo(tx.memo_base64);
    if (!memo.includes(order.memo)) {
      return { ok: false, error: { code: "memo_mismatch" } };
    }

    // Contract result checks — decisive once the result is visible.
    if (!cr) {
      lastError = { code: "verification_timeout", detail: "contract_result_not_visible" };
      if (attempt < attempts - 1) await sleep(intervalMs);
      continue;
    }
    if (cr.status !== "0x1") {
      return { ok: false, error: { code: "tx_failed", detail: cr.status ?? "unknown" } };
    }
    if (normalizeToAccountId(cr.to) !== config.tipsAccountId) {
      return { ok: false, error: { code: "wrong_contract", detail: cr.to ?? "unknown" } };
    }
    const selector = (cr.function_parameters ?? "").slice(0, 10).toLowerCase();
    if (selector !== TIP_PAGE_SELECTOR) {
      return { ok: false, error: { code: "wrong_function", detail: selector || "none" } };
    }
    // Brandon's rule: the payment must go to HIS username. A buyer who
    // tips any other username gets rejected — we never accept and re-route.
    const paidUsername = decodeTipPageUsername(cr.function_parameters);
    if (paidUsername !== order.recipientUsername) {
      return {
        ok: false,
        error: {
          code: "wrong_recipient",
          detail: `paid "${paidUsername ?? "undecodable"}" — order requires "${order.recipientUsername}"`,
        },
      };
    }
    const amount = BigInt(cr.amount ?? "0");
    if (amount < requiredTinybar) {
      return {
        ok: false,
        error: {
          code: "underpaid",
          detail: `${Number(amount) / 1e8} HBAR < ${order.priceHbar} HBAR`,
        },
      };
    }

    // All checks hold — claim exactly once.
    try {
      const entitlement = markOrderPaid(orderId, txId, now());
      return { ok: true, entitlement };
    } catch {
      return { ok: false, error: { code: "already_claimed" } };
    }
  }

  return { ok: false, error: lastError };
}
