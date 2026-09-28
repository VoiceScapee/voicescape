/**
 * Pay-with-any-token for tips.
 *
 * Lets a visitor tip with an HTS token they already hold (USDC, SAUCE, …).
 * The whole flow stays in the visitor's own wallet — Voicescape never
 * touches their tokens and nothing changes on-chain:
 *   1. (once per token) the visitor approves the Saucerswap router to move
 *      exactly the swap amount — signed in their wallet
 *   2. the token is swapped to HBAR through the Saucerswap V1 router —
 *      signed in their wallet
 *   3. the HBAR is tipped through the existing Tips contract (98/2 split) —
 *      signed in their wallet
 *
 * Router + WHBAR ids verified against the official Saucerswap deployment
 * docs (2026-09-28): SaucerSwapV1RouterV3 = 0.0.3045981, WHBAR = 0.0.1456986.
 * Quotes are read-only (mirror-node eth_call, no gas, no signature).
 *
 * Hedera specifics that bit us before (proven on mainnet, see
 * lib/session-message.ts): HTS token contracts live at their long-zero EVM
 * address, but a contract HBAR *push* only reaches an account at its real
 * (alias) EVM address — so the swap's `to` is read from the mirror node,
 * never derived as long-zero.
 */
import { Interface } from "ethers";
import type { ChainConfig } from "./chains";
import { mirrorContractCall, SWAP_GAS, APPROVE_GAS } from "./tx";

export { SWAP_GAS, APPROVE_GAS };

/** Saucerswap V1 router (current). Verified in official docs 2026-09-28. */
export const SAUCER_ROUTER_ID = "0.0.3045981";
/** Wrapped HBAR token id — the HBAR leg of every swap path. */
export const WHBAR_ID = "0.0.1456986";
/** Slippage guard on the quoted output, in basis points (200 = 2%). */
export const SWAP_SLIPPAGE_BPS = 200;
/** How long the swap stays valid after signing (seconds). */
export const SWAP_DEADLINE_SECS = 20 * 60;

const ROUTER_IFACE = new Interface([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

/**
 * Hedera entity id ("0.0.3045981") -> long-zero EVM address
 * ("0x0000…2e7aad"). Tokens and contracts (not user accounts) live here.
 * Exported for tests.
 */
export function tokenIdToEvmAddress(tokenId: string): string {
  const m = /^0\.0\.(\d+)$/.exec(tokenId.trim());
  if (!m) throw new Error(`Not a Hedera token id: "${tokenId}".`);
  const numHex = BigInt(m[1]).toString(16).padStart(16, "0");
  return `0x${"0".repeat(24)}${numHex}`;
}

/** Mirror-node REST base (mainnet only — same rule as lib/tx.ts). */
function mirrorBase(chain: ChainConfig): string {
  return "https://mainnet.mirrornode.hedera.com";
}

async function mirrorGet(chain: ChainConfig, path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${mirrorBase(chain)}${path}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`Mirror node ${res.status} on ${path}.`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Quote                                                               */
/* ------------------------------------------------------------------ */

export interface SwapQuote {
  tokenId: string;
  /** Input amount in the token's smallest unit. */
  amountIn: bigint;
  /** Quoted HBAR out, 18-decimal wei (what the router's EVM side uses). */
  hbarOutWei: bigint;
  /** hbarOutWei minus the slippage guard — the most the tip can rely on. */
  minOutWei: bigint;
  /** Swap path as EVM addresses: [token, WHBAR]. */
  path: string[];
}

/**
 * Read-only quote: how much HBAR `amountIn` (smallest unit) of `tokenId`
 * buys right now. Throws a plain-words error when there is no route.
 */
export async function getSwapQuote(
  chain: ChainConfig,
  tokenId: string,
  amountIn: bigint,
): Promise<SwapQuote> {
  if (amountIn <= 0n) throw new Error("Enter an amount greater than zero.");
  const tokenEvm = tokenIdToEvmAddress(tokenId);
  const whbarEvm = tokenIdToEvmAddress(WHBAR_ID);
  const routerEvm = tokenIdToEvmAddress(SAUCER_ROUTER_ID);
  const path = [tokenEvm, whbarEvm];
  const data = ROUTER_IFACE.encodeFunctionData("getAmountsOut", [amountIn, path]);
  let raw: string;
  try {
    raw = await mirrorContractCall(chain, routerEvm, data);
  } catch {
    throw new Error(
      "No swap route for this token right now — tip in HBAR instead.",
    );
  }
  const [amounts] = ROUTER_IFACE.decodeFunctionResult("getAmountsOut", raw) as unknown as [
    bigint[],
  ];
  const hbarOutWei = amounts?.[amounts.length - 1];
  if (hbarOutWei === undefined || hbarOutWei <= 0n) {
    throw new Error(
      "No swap route for this token right now — tip in HBAR instead.",
    );
  }
  const minOutWei = (hbarOutWei * BigInt(10_000 - SWAP_SLIPPAGE_BPS)) / 10_000n;
  return { tokenId, amountIn, hbarOutWei, minOutWei, path };
}

/* ------------------------------------------------------------------ */
/* Visitor's tokens + account address                                  */
/* ------------------------------------------------------------------ */

export interface WalletToken {
  tokenId: string;
  symbol: string;
  decimals: number;
  /** Raw balance in the token's smallest unit. */
  balance: bigint;
}

/**
 * HTS tokens the connected wallet holds (balance > 0), with symbol and
 * decimals. `accountId` may be "0.0.x" or a long-zero 0x address.
 */
export async function getWalletTokens(
  chain: ChainConfig,
  accountId: string,
): Promise<WalletToken[]> {
  const body = (await mirrorGet(
    chain,
    `/api/v1/accounts/${accountId}/tokens?limit=100`,
  )) as { tokens?: Array<{ token_id?: string; balance?: number | string }> };
  const held = (body.tokens ?? []).filter((t) => {
    try {
      return BigInt(t.balance ?? 0) > 0n && typeof t.token_id === "string";
    } catch {
      return false;
    }
  });
  const detailed = await Promise.all(
    held.map(async (t) => {
      const tokenId = t.token_id as string;
      try {
        const meta = (await mirrorGet(chain, `/api/v1/tokens/${tokenId}`)) as {
          symbol?: string;
          decimals?: number | string;
        };
        return {
          tokenId,
          symbol: meta.symbol?.trim() || tokenId,
          decimals: Number(meta.decimals ?? 0),
          balance: BigInt(t.balance ?? 0),
        } satisfies WalletToken;
      } catch {
        return null;
      }
    }),
  );
  return detailed.filter((t): t is WalletToken => t !== null && t.decimals >= 0);
}

/**
 * The account's real EVM address (alias form for ECDSA wallets), from the
 * mirror node. Null when the account has none — the swap can't deliver HBAR
 * to it, so token mode must stay off.
 */
export async function getAccountEvmAddress(
  chain: ChainConfig,
  accountId: string,
): Promise<string | null> {
  try {
    const body = (await mirrorGet(chain, `/api/v1/accounts/${accountId}`)) as {
      evm_address?: string;
    };
    const addr = body.evm_address?.trim();
    return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? addr : null;
  } catch {
    return null;
  }
}

/**
 * Does `ownerId` already let the Saucerswap router move at least `needed`
 * (smallest unit) of `tokenId`? Checked via the mirror node — no signature.
 */
export async function hasTokenAllowance(
  chain: ChainConfig,
  ownerId: string,
  tokenId: string,
  needed: bigint,
): Promise<boolean> {
  try {
    const body = (await mirrorGet(
      chain,
      `/api/v1/accounts/${ownerId}/allowances/tokens?limit=100`,
    )) as {
      allowances?: Array<{ token_id?: string; spender?: string; amount?: number | string }>;
    };
    const routerId = SAUCER_ROUTER_ID;
    return (body.allowances ?? []).some((a) => {
      if (a.token_id !== tokenId || a.spender !== routerId) return false;
      try {
        return BigInt(a.amount ?? 0) >= needed;
      } catch {
        return false;
      }
    });
  } catch {
    // Allowance state unreadable — safest to prompt the approval.
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Amount parsing (pure — unit-tested)                                 */
/* ------------------------------------------------------------------ */

/**
 * Parse a human token amount ("1.5") into the smallest unit for a token
 * with `decimals` places. Returns null for junk/zero. No floats — string
 * math only, so 6-decimal tokens stay exact. Exported for tests.
 */
export function parseTokenAmount(input: string, decimals: number): bigint | null {
  const cleaned = input.trim().replace(/[^0-9.]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  if (frac.length > decimals) return null;
  const raw = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return raw > 0n ? raw : null;
}

/** Smallest-unit bigint -> human display ("1500000", 6 -> "1.5"). Exported for tests. */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** 18-decimal wei -> HBAR float for display. Exported for tests. */
export function weiToHbar(wei: bigint): number {
  return Number(wei) / 1e18;
}
