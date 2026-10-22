/**
 * One canonical source for the Tips contract's event ABIs and topic hashes.
 *
 * FIRST PRINCIPLE: every surface that reads TipSent / PurchaseCompleted
 * logs — analytics, market leaders, webhooks, push, notify, and EVM
 * verification — must agree on the event shape, or one surface silently
 * stops recognizing the other's events. These two event strings were
 * copied into five modules; this file is the only place they are spelled
 * out now. The strict per-event decoders (lib/leaderboard.ts for tips,
 * lib/server/notify.ts for purchases) keep their own validation; this
 * module owns the ABI and the topic hash only.
 */

import { ethers } from "ethers";

export const TIPSENT_IFACE = new ethers.Interface([
  "event TipSent(string indexed username, address indexed from, address indexed toOwner, uint256 amount, uint256 fee)",
]);

export const PURCHASE_IFACE = new ethers.Interface([
  "event PurchaseCompleted(address indexed buyer, address indexed seller, string listingRef, uint256 amount, uint256 fee)",
]);

export const TIPSENT_TOPIC0 = TIPSENT_IFACE.getEvent("TipSent")!.topicHash.toLowerCase();

export const PURCHASE_TOPIC0 =
  PURCHASE_IFACE.getEvent("PurchaseCompleted")!.topicHash.toLowerCase();
