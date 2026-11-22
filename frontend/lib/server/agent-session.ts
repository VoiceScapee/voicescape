/**
 * agent-session — session auth for the chat-adjacent agent routes
 * (/api/agents/overview, /api/agents/proposals, /api/agents/tokens,
 * /api/agents/page-updates/.../finalize).
 *
 * Returns the signed-in wallet's Hedera account id in "0.0.x" form, or null
 * when the request carries no valid session. The dashboard and the approval
 * inbox are strictly per-owner: no session, no data.
 *
 * ROOT FIX (2026-11-22): the session carries the wallet's EVM address,
 * which for ECDSA-keyed wallets (HashPack's default) is the ALIAS
 * (0x4fb7…), not the long-zero form. The old code derived the account id
 * with BigInt() over whatever 40 hex chars it got — an alias becomes a
 * bogus "0.0.<astronomical>" that matches no real account, so an ECDSA
 * agent's dashboard/inbox/tokens all came back empty (misread as a
 * stranger). The F1 fix (2026-11-21, lib/account-evm.ts) patched the
 * builder/page owner comparisons; this is the same bug at its root, in
 * the session→account resolution every agent route shares.
 *
 * Resolve properly: long-zero addresses derive locally
 * (lib/session-message longZeroToAccountId, which returns null for
 * non-long-zero forms); alias addresses resolve through the mirror node
 * (GET /api/v1/accounts/{evmAddress} -> account). Fail closed (null)
 * when the mirror cannot resolve the alias — a wrong identity is worse
 * than no identity, and every caller already treats null as "no session".
 */
import type { NextRequest } from "next/server";
import { sessionCredentialFrom } from "./townhall/route-auth";
import { verifySessionToken } from "./townhall/auth";
import { longZeroToAccountId } from "../session-message";
import { mirrorBaseUrl } from "./townhall/topics";

const MIRROR_ACCOUNT_TIMEOUT_MS = 5_000;

/**
 * Resolve a session EVM address to its Hedera account id ("0.0.x").
 * Long-zero form derives locally; alias form resolves via the mirror
 * node. Null when the address cannot be resolved to a real account.
 * Never throws.
 */
export async function sessionAddressToAccountId(
  address: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const addr = (address ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
  const longZero = longZeroToAccountId(addr);
  if (longZero) return longZero;
  // Alias form (ECDSA wallet): the mirror node is the only source of
  // truth for which account an alias belongs to.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MIRROR_ACCOUNT_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${mirrorBaseUrl()}/api/v1/accounts/${addr.toLowerCase()}`, {
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json().catch(() => null)) as { account?: unknown } | null;
      const account = json?.account;
      return typeof account === "string" && /^0\.0\.\d+$/.test(account) ? account : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

export async function agentOwnerFromRequest(req: NextRequest): Promise<string | null> {
  const cred = sessionCredentialFrom(req);
  if (typeof cred !== "string") return null;
  const verified = await verifySessionToken(cred);
  if (!verified || !verified.ok) return null;
  return sessionAddressToAccountId(verified.session.address);
}
