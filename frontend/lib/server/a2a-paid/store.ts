/**
 * In-memory order store + tx-id claim registry for the paid endpoint prototype.
 *
 * Order state machine: issued → paid → fulfilled.
 * - issued: bill handed out, awaiting payment.
 * - paid: mirror-verified payment exactly once (tx id claimed).
 * - fulfilled: the product was delivered. A paid-but-unfulfilled order is
 *   retryable without re-payment (crash-safe); the claim registry makes
 *   double-spend of one tx impossible even across restarts of the flow.
 *
 * Prototype scope: per-instance memory. Before mainnet this MUST move to a
 * durable shared store (Upstash, atomic claim). The module is written so the
 * swap is mechanical (all state access goes through these functions).
 */

import type { PaidProduct } from "./config";

export type OrderState = "issued" | "paid" | "fulfilled";

export interface PaidOrder {
  orderId: string;
  product: PaidProduct;
  buyerAccount: string;
  priceHbar: number;
  /** Required tx memo binding the payment to this order. */
  memo: string;
  expiresAt: number;
  state: OrderState;
  txId?: string;
  paidAt?: number;
  entitlement?: Entitlement;
}

export interface Entitlement {
  orderId: string;
  product: PaidProduct;
  buyerAccount: string;
  txId: string;
  paidAt: number;
}

const orders = new Map<string, PaidOrder>();
/** txId (mirror dash form) -> orderId. The idempotency key for payments. */
const claims = new Map<string, string>();

export function putOrder(order: PaidOrder): void {
  orders.set(order.orderId, order);
}

export function getOrder(orderId: string): PaidOrder | undefined {
  return orders.get(orderId);
}

export function isOrderExpired(order: PaidOrder, now: number = Date.now()): boolean {
  return now > order.expiresAt;
}

/**
 * Mark an order paid and record the tx claim atomically (single-threaded
 * check-then-set; the durable store must use a real atomic op).
 * Throws when the transition is illegal or the tx was already claimed.
 */
export function markOrderPaid(orderId: string, txId: string, now: number = Date.now()): Entitlement {
  const order = orders.get(orderId);
  if (!order) throw new Error("order_not_found");
  if (order.state !== "issued") throw new Error("order_not_issuable_state");
  if (isOrderExpired(order, now)) throw new Error("order_expired");
  if (claims.has(txId)) throw new Error("already_claimed");
  const entitlement: Entitlement = {
    orderId,
    product: order.product,
    buyerAccount: order.buyerAccount,
    txId,
    paidAt: now,
  };
  claims.set(txId, orderId);
  order.state = "paid";
  order.txId = txId;
  order.paidAt = now;
  order.entitlement = entitlement;
  return entitlement;
}

export function isTxClaimed(txId: string): boolean {
  return claims.has(txId);
}

/** Record a claim without a state transition (used only by tests). */
export function __testClaim(txId: string, orderId: string): void {
  claims.set(txId, orderId);
}

/** Transition paid → fulfilled. Only the delivery path calls this. */
export function fulfillOrder(orderId: string): PaidOrder {
  const order = orders.get(orderId);
  if (!order) throw new Error("order_not_found");
  if (order.state !== "paid") throw new Error("order_not_paid");
  order.state = "fulfilled";
  return order;
}

/** Test-only reset. */
export function __resetPaidStore(): void {
  orders.clear();
  claims.clear();
}
