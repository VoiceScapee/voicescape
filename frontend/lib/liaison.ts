/**
 * Liaison slice-1 shared logic (client + server safe — no Node-only imports).
 *
 * The liaison is the paid human-facing helper behind the /danny blockpage:
 * humans connect their wallet, tip to unlock a help session, chat, and get
 * a premade blockpage draft bound to their wallet. Prime directive: the
 * liaison is a *hired helper, never a custodian* — it can never publish for
 * the user, sign for the user, or touch a published page.
 *
 * ethers is used here ONLY as an EVM calldata/topic decoder (keccak256 of
 * the username for log topic matching) — never as a chain connection,
 * per the deploy gate.
 */
import { ethers } from "ethers";
import { decodeTipSentLog } from "./leaderboard";

/** The liaison's blockpage username — tips and drafts are bound to it. */
export const LIAISON_USERNAME = "danny";

/**
 * danny's on-chain page owner (the liaison wallet). Verified 2026-09-14
 * against mainnet PageRegistered logs: the agent registration at
 * 2026-09-14 01:41 UTC carries this owner. TipSent logs must point at it.
 */
export const LIAISON_OWNER_EVM = "0x4fb76eaa5eb6152501e99ca385c21d3dedf4ccca";

/** Live Tips contract (98/2 split, no escrow). */
export const LIAISON_TIPS_CONTRACT_ID = "0.0.10854060";

/** Live Registry contract (publish confirmation reads PageRegistered). */
export const LIAISON_REGISTRY_CONTRACT_ID = "0.0.10854058";

/**
 * The liaison wallet's account id. Verified 2026-09-14 against the mirror
 * node: 0.0.10857765 carries evm_address 0x4fb76eaa5eb6152501e99ca385c21d3dedf4ccca
 * (= LIAISON_OWNER_EVM, the PageRegistered owner). Used for the revenue
 * sweep balance check — the liaison's own money, never user funds.
 */
export const LIAISON_ACCOUNT_ID = "0.0.10857765";

/** Voicescape treasury — liaison revenue sweeps land here. */
export const LIAISON_TREASURY_ID = "0.0.10424063";

export const MIRROR_NODE_BASE = "https://mainnet.mirrornode.hedera.com";

/** Slice-1 entitlements granted per paid help session. */
export const LIAISON_CHAT_PER_PAYMENT = 50;
export const LIAISON_BUILDS_PER_PAYMENT = 1;
/** There is NO free tier (Brandon's call): the Danny paywall starts at the
 * first message — every chat message and every help-build costs a fee. */

export const LIAISON_ENTITLEMENT_TTL_MS = 7 * 24 * 3600_000;
export const LIAISON_DRAFT_TTL_MS = 30 * 24 * 3600_000;
export const LIAISON_TIP_CLAIM_TTL_MS = 30 * 24 * 3600_000;
export const LIAISON_HISTORY_TTL_MS = 24 * 3600_000;

export const LIAISON_MAX_DRAFT_BYTES = 100_000;
export const LIAISON_MAX_MESSAGE_CHARS = 1000;
export const LIAISON_HISTORY_LIMIT = 10;

/** Slice-1 products. Brandon's call (2026-09-14): 5 HBAR per page build,
 * 5 HBAR per 50-message chat session. No bundle, no free tier — each
 * product is bought separately. */
export type LiaisonProduct = "chat" | "build";

/** Price of a 50-message chat session in HBAR (Brandon's call; env-tunable). */
export function liaisonChatPriceHbar(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.LIAISON_CHAT_PRICE_HBAR);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/** Price of one page build in HBAR (Brandon's call; env-tunable). */
export function liaisonBuildPriceHbar(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.LIAISON_BUILD_PRICE_HBAR);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/**
 * Floor below which the liaison refuses to serve (default 1 HBAR).
 *
 * MARGIN MATH (economics invariant — the platform never loses money on a
 * liaison session). Slice-1 marginal cost per paid session is ~$0:
 *  - chat answers: deterministic in-repo knowledge base — no LLM call, no
 *    per-request fee, no paid API;
 *  - blockpage build: deterministic template assembly — no LLM, and no
 *    IPFS pin happens until the user publishes through the existing
 *    (already-free) builder flow;
 *  - chain reads: official mirror-node REST — free, no key;
 *  - draft storage: wallet-scoped KV on the Vercel free tier;
 *  - revenue sweep: one ~$0.0001 HBAR transfer per sweep, paid from the
 *    liaison's own 98% share (never from treasury or users).
 * So any price at or above the floor is profitable by construction. The
 * floor exists only to make a misconfigured LIAISON_CHAT_PRICE_HBAR or
 * LIAISON_BUILD_PRICE_HBAR (e.g. 0.0001 HBAR from a typo) fail closed at
 * boot instead of selling help at a loss.
 */
export function liaisonPriceFloorHbar(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.LIAISON_PRICE_FLOOR_HBAR);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** Throw when either configured product price sits below the floor — routes
 * refuse to serve. Both prices are checked: a misconfigured chat OR build
 * price fails closed, never sells help at a loss. */
export function assertLiaisonPriceFloors(
  chatPriceHbar: number,
  buildPriceHbar: number,
  floorHbar: number,
): void {
  for (const [name, env, price] of [
    ["chat", "LIAISON_CHAT_PRICE_HBAR", chatPriceHbar],
    ["build", "LIAISON_BUILD_PRICE_HBAR", buildPriceHbar],
  ] as const) {
    if (!(price >= floorHbar)) {
      throw new Error(
        `${env} (${price}) is below the floor (${floorHbar}) — refusing to serve paid liaison ${name} routes`,
      );
    }
  }
}

/**
 * HBAR the liaison wallet keeps as a fee reserve before sweeping revenue
 * to treasury (default 1). Env-tunable.
 */
export function liaisonForwardReserveHbar(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.LIAISON_FORWARD_RESERVE_HBAR);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

/**
 * Forwardable balance (tinybar) above which a sweep fires (default 0 —
 * forward everything above the reserve). Env-tunable.
 */
export function liaisonForwardThresholdHbar(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.LIAISON_FORWARD_THRESHOLD_HBAR);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

/**
 * How much of the liaison wallet's balance may be swept to treasury, in
 * tinybar. Returns 0n when the forwardable amount (balance − reserve)
 * does not exceed the threshold.
 */
export function computeForwardable(
  balanceTinybar: bigint,
  reserveTinybar: bigint,
  thresholdTinybar: bigint,
): bigint {
  const forwardable = balanceTinybar - reserveTinybar;
  return forwardable > thresholdTinybar ? forwardable : 0n;
}

/* ---------------- KV keys (all wallet-scoped, TTL'd) ---------------- */

export const liaisonEntKey = (addr: string): string =>
  `vs:liaison:ent:${addr.toLowerCase()}`;
export const liaisonTipKey = (claimId: string): string =>
  `vs:liaison:tip:${claimId}`;
export const liaisonDraftKey = (addr: string): string =>
  `vs:liaison:draft:${addr.toLowerCase()}`;
export const liaisonHistKey = (addr: string): string =>
  `vs:liaison:hist:${addr.toLowerCase()}`;

/* ---------------- Entitlements ---------------- */

export interface LiaisonEntitlement {
  chatLeft: number;
  buildsLeft: number;
  /** Epoch ms when the entitlement expires. */
  expMs: number;
}

export function parseEntitlement(raw: unknown): LiaisonEntitlement | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const chatLeft = e.chatLeft;
  const buildsLeft = e.buildsLeft;
  const expMs = e.expMs;
  if (
    typeof chatLeft !== "number" ||
    typeof buildsLeft !== "number" ||
    typeof expMs !== "number"
  ) {
    return null;
  }
  if (!Number.isFinite(chatLeft) || !Number.isFinite(buildsLeft) || !Number.isFinite(expMs)) {
    return null;
  }
  return {
    chatLeft: Math.max(0, Math.floor(chatLeft)),
    buildsLeft: Math.max(0, Math.floor(buildsLeft)),
    expMs,
  };
}

export function entitlementAlive(ent: LiaisonEntitlement, nowMs: number): boolean {
  return ent.expMs > nowMs && (ent.chatLeft > 0 || ent.buildsLeft > 0);
}

/* ---------------- Transaction-id normalization ---------------- */

/**
 * Normalize a user-supplied transaction reference for mirror-node reads.
 * Accepts the wallet/SDK form `0.0.x@seconds.nanos`, the mirror form
 * `0.0.x-seconds-nanos`, and 0x transaction hashes. Returns null when the
 * shape is unrecognizable (never throw on user input).
 */
export function normalizeTxRef(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase();
  const m = t.match(/^(\d+\.\d+\.\d+)[@-](\d+)[.-](\d{1,9})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3].padStart(9, "0")}`;
}

/* ---------------- Mirror-node verification (pure) ---------------- */

/** keccak256("danny") — the indexed username topic on TipSent/PageRegistered. */
export function liaisonUsernameTopic(): string {
  return ethers.keccak256(ethers.toUtf8Bytes(LIAISON_USERNAME));
}

export interface MirrorTxRecord {
  result?: unknown;
  name?: unknown;
}

/** The transaction reached consensus successfully as a contract call. */
export function isSuccessfulContractCall(tx: unknown): boolean {
  if (!tx || typeof tx !== "object") return false;
  const t = tx as MirrorTxRecord;
  if (t.result !== "SUCCESS") return false;
  const name = typeof t.name === "string" ? t.name : "";
  return name === "CONTRACT_CALL" || name === "CONTRACTCALL";
}

/**
 * A mirror-node log is a *paid liaison tip* when it decodes as TipSent with:
 * - from == one of the payer's on-chain addresses,
 * - to == danny's on-chain owner (the 98% recipient),
 * - amount >= the session price (the event records the full tipped value),
 * - the indexed username topic == keccak256("danny") (the tip was FOR danny).
 *
 * The payer's address needs the extraFromAddrs list because Hedera wallet
 * sessions are keyed by the account's long-zero address, while contract
 * logs carry msg.sender — the account's key-derived EVM address. Without
 * the alias, every real wallet's tip verifies on-chain but never credits.
 */
export function isLiaisonTipLog(
  log: unknown,
  sessionAddr: string,
  priceHbar: number,
  extraFromAddrs: string[] = [],
): boolean {
  const ev = decodeTipSentLog(log);
  if (!ev) return false;
  const fromOk = [sessionAddr, ...extraFromAddrs].some(
    (a) => typeof a === "string" && ev.from === a.toLowerCase(),
  );
  if (!fromOk) return false;
  if (ev.to !== LIAISON_OWNER_EVM) return false;
  // The Tips contract splits 98/2 on-chain: Danny receives 98% of the paid
  // amount, the treasury takes 2%. The event logs Danny's net receipt, so
  // the check must allow for the fee (plus a 1% tolerance for rounding).
  if (!(ev.amountHbar >= priceHbar * 0.97)) return false;
  const topics =
    log && typeof log === "object"
      ? (log as { topics?: unknown }).topics
      : undefined;
  const usernameTopic =
    Array.isArray(topics) && typeof topics[1] === "string"
      ? (topics[1] as string).toLowerCase()
      : "";
  return usernameTopic === liaisonUsernameTopic();
}

/**
 * Decode the username argument of a registerPage(string,...) call from
 * mirror-node contract-result function_parameters (0x + selector + ABI).
 * Same offset logic as the agents directory route.
 */
export function decodeRegisterUsername(functionParameters: unknown): string | null {
  try {
    if (typeof functionParameters !== "string") return null;
    const hex = functionParameters.startsWith("0x")
      ? functionParameters.slice(2)
      : functionParameters;
    if (hex.length < 8 + 64) return null;
    const offset = parseInt(hex.slice(8, 8 + 64), 16);
    const strStart = 8 + offset * 2;
    const len = parseInt(hex.slice(strStart, strStart + 64), 16);
    if (len <= 0 || len > 64) return null;
    const strHex = hex.slice(strStart + 64, strStart + 64 + len * 2);
    const username = Buffer.from(strHex, "hex").toString("utf8");
    if (!/^[a-z0-9_-]{3,32}$/.test(username)) return null;
    return username;
  } catch {
    return null;
  }
}

/**
 * A PageRegistered log belongs to this publish when the indexed username
 * topic matches keccak256(username) and the indexed owner is one of the
 * session wallet's on-chain addresses (long-zero session form or the
 * key-derived EVM address contracts actually log as msg.sender).
 */
export function isOwnPageRegisteredLog(
  log: unknown,
  username: string,
  sessionAddr: string,
  extraOwnerAddrs: string[] = [],
): boolean {
  if (!log || typeof log !== "object") return false;
  const topics = (log as { topics?: unknown }).topics;
  if (!Array.isArray(topics) || topics.length < 3) return false;
  const usernameTopic =
    typeof topics[1] === "string" ? (topics[1] as string).toLowerCase() : "";
  const ownerTopic =
    typeof topics[2] === "string" ? (topics[2] as string).toLowerCase() : "";
  const wantUsername = ethers
    .keccak256(ethers.toUtf8Bytes(username.toLowerCase()))
    .toLowerCase();
  const ownerOk = [sessionAddr, ...extraOwnerAddrs].some(
    (a) =>
      typeof a === "string" &&
      ownerTopic === `0x${"0".repeat(24)}${a.toLowerCase().replace(/^0x/, "")}`,
  );
  return usernameTopic === wantUsername && ownerOk;
}
