/**
 * Scoped agent-token enforcement helpers.
 *
 * An agent token (v2) authenticates as a wallet PLUS one agent username
 * (VerifiedSession.agent). Every allowlisted route funnels through these
 * helpers so the scope rule lives in exactly one place:
 *
 *   - no agent scope  → the session is a full human session: allowed
 *     wherever the route otherwise allows it.
 *   - agent scope     → the action must be namespaced to the agent's own
 *     username. Anything else is denied.
 *
 * Routes that never call these helpers (and never pass { allowAgent: true }
 * to verifySession) reject agent tokens outright — the fail-closed default.
 */
import type { VerifiedSession } from "./auth";

export interface AgentScope {
  /** The human wallet that minted the token (0x lowercase). */
  address: string;
  /** The ONE agent username this token may act as (lowercase). */
  agent: string;
}

/** The scope carried by a verified session, or null for full sessions. */
export function agentScopeFromSession(session: VerifiedSession): AgentScope | null {
  if (!session.agent?.username) return null;
  return { address: session.address.toLowerCase(), agent: session.agent.username.toLowerCase() };
}

/**
 * Quota-bucket key for this session. Agent-token writes count against
 * `agent:<addr>:<agent>` — never the human's own bucket — so a rogue or
 * buggy agent cannot burn the human's quotas (or the operator's funds).
 * Returns null for full human sessions (callers keep their wallet key).
 */
export function agentQuotaKey(session: VerifiedSession): string | null {
  const scope = agentScopeFromSession(session);
  if (!scope) return null;
  return `agent:${scope.address}:${scope.agent}`;
}

/**
 * Scope gate for a username-namespaced action (pin a page doc, post as an
 * author, manage a listing, claim an intro). Full sessions pass through;
 * agent sessions pass only when the claimed username IS the token's agent.
 */
export function requireAgentScopeForUsername(
  session: VerifiedSession,
  claimedUsername: unknown,
): { ok: true } | { ok: false; error: string } {
  const scope = agentScopeFromSession(session);
  if (!scope) return { ok: true };
  const claimed = typeof claimedUsername === "string" ? claimedUsername.trim().toLowerCase() : "";
  if (!claimed) return { ok: false, error: "a username is required" };
  if (claimed !== scope.agent) {
    return {
      ok: false,
      error: `this agent token is scoped to "${scope.agent}" and cannot act as "${claimed}"`,
    };
  }
  return { ok: true };
}
