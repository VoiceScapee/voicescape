/**
 * Order issuance: POST /api/a2a/orders
 *
 * Buyer asks for a product; we check they can afford it on Hedera testnet
 * and hand back a bill (HTTP 402 semantics: payment required, here's how).
 * The buyer pays from their own wallet via tipPage with the order-bound memo;
 * our server never holds spend keys.
 */

import { randomBytes } from "crypto";
import {
  FEE_BUFFER_HBAR,
  ORDER_TTL_MS,
  PAID_PRODUCTS,
  PRICE_HBAR,
  getPaidConfig,
  hbarToTinybar,
  isAccountIdForm,
  type PaidConfig,
  type PaidProduct,
} from "./config";
import { getAccountBalanceTinybar, type FetchFn } from "./mirror";
import { putOrder, type PaidOrder } from "./store";

export interface IssueOrderInput {
  product: string;
  buyerAccount: string;
}

export interface OrderBill {
  orderId: string;
  priceHbar: number;
  payTo: string;
  /** The username the buyer must pass to tipPage — Brandon's wallet. */
  payToUsername: string;
  function: "tipPage";
  memo: string;
  expiresAt: number;
}

export type IssueOrderError =
  | { code: "invalid_product" }
  | { code: "invalid_buyer_account" }
  | { code: "insufficient_balance"; balanceHbar: number; requiredHbar: number }
  | { code: "account_not_found" }
  | { code: "misconfigured"; message: string };

export interface IssueOrderDeps {
  fetchFn?: FetchFn;
  now?: () => number;
  env?: Record<string, string | undefined>;
  orderId?: () => string;
}

export function memoForOrder(orderId: string): string {
  return `vs-order:${orderId}`;
}

export async function issueOrder(
  input: IssueOrderInput,
  deps: IssueOrderDeps = {},
): Promise<{ ok: true; bill: OrderBill } | { ok: false; error: IssueOrderError }> {
  const now = deps.now ?? Date.now;
  const product = input.product as PaidProduct;
  if (!PAID_PRODUCTS.includes(product)) {
    return { ok: false, error: { code: "invalid_product" } };
  }
  const buyerAccount = (input.buyerAccount ?? "").trim();
  if (!isAccountIdForm(buyerAccount)) {
    return { ok: false, error: { code: "invalid_buyer_account" } };
  }

  let config: PaidConfig;
  try {
    config = getPaidConfig(deps.env);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "misconfigured",
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  const requiredTinybar = hbarToTinybar(PRICE_HBAR + FEE_BUFFER_HBAR);
  let balance: bigint | null;
  try {
    balance = await getAccountBalanceTinybar(
      config.mirrorBase,
      buyerAccount,
      deps.fetchFn ?? fetch,
    );
  } catch {
    return {
      ok: false,
      error: { code: "misconfigured", message: "mirror_error: balance check failed" },
    };
  }
  if (balance === null) {
    return { ok: false, error: { code: "account_not_found" } };
  }
  if (balance < requiredTinybar) {
    return {
      ok: false,
      error: {
        code: "insufficient_balance",
        balanceHbar: Number(balance) / 1e8,
        requiredHbar: PRICE_HBAR + FEE_BUFFER_HBAR,
      },
    };
  }

  const orderId = deps.orderId ? deps.orderId() : randomBytes(12).toString("hex");
  const order: PaidOrder = {
    orderId,
    product,
    buyerAccount,
    priceHbar: PRICE_HBAR,
    memo: memoForOrder(orderId),
    recipientUsername: config.recipientUsername,
    expiresAt: now() + ORDER_TTL_MS,
    state: "issued",
  };
  putOrder(order);

  return {
    ok: true,
    bill: {
      orderId,
      priceHbar: PRICE_HBAR,
      payTo: config.tipsAccountId,
      payToUsername: config.recipientUsername,
      function: "tipPage",
      memo: order.memo,
      expiresAt: order.expiresAt,
    },
  };
}
