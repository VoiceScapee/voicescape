/**
 * Tests for the agent-token scope helpers (fail-closed boundary).
 *
 * The invariants under test:
 *  1. Full human sessions are untouched by scope logic (always pass).
 *  2. An agent token may only act as its own agent username (case-insensitive).
 *  3. An agent token may never escalate — even to a page its wallet owns.
 *  4. Agent writes draw from their own quota bucket, never the human's.
 */
import { describe, expect, it } from "vitest";
import {
  agentQuotaKey,
  agentScopeFromSession,
  requireAgentScopeForUsername,
} from "./agent-scope";
import type { VerifiedSession } from "./auth";

const WALLET = "0x0000000000000000000000000000000000001234";

function humanSession(): VerifiedSession {
  return {
    address: WALLET,
    chainId: 296,
    nonce: "n1",
    expiresAtMs: Date.now() + 3600_000,
  };
}

function agentSession(username: string): VerifiedSession {
  return {
    address: WALLET,
    chainId: 296,
    nonce: "n2",
    expiresAtMs: Date.now() + 3600_000,
    agent: { username },
  };
}

describe("requireAgentScopeForUsername", () => {
  it("a full human session passes for any username", () => {
    const s = humanSession();
    expect(requireAgentScopeForUsername(s, "anyone").ok).toBe(true);
    expect(requireAgentScopeForUsername(s, "thechomps").ok).toBe(true);
  });

  it("an agent token passes for its own username (case-insensitive)", () => {
    const s = agentSession("thechomps");
    expect(requireAgentScopeForUsername(s, "thechomps").ok).toBe(true);
    expect(requireAgentScopeForUsername(s, "TheChomps").ok).toBe(true);
  });

  it("an agent token is rejected for anyone else's username — even the human's own page", () => {
    const s = agentSession("thechomps");
    const r = requireAgentScopeForUsername(s, "user-10424063");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("an agent token is rejected for another agent's username", () => {
    const s = agentSession("thechomps");
    const r = requireAgentScopeForUsername(s, "otherbot");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toContain("thechomps");
    }
  });

  it("a malformed username is rejected with 400, not 403", () => {
    const s = agentSession("thechomps");
    const r = requireAgentScopeForUsername(s, "BAD NAME!");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("a missing username is rejected with 400", () => {
    const s = agentSession("thechomps");
    const r = requireAgentScopeForUsername(s, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});

describe("agentQuotaKey", () => {
  it("returns null for a full human session (wallet bucket)", () => {
    expect(agentQuotaKey(humanSession())).toBeNull();
  });

  it("returns a distinct bucket for an agent session", () => {
    const key = agentQuotaKey(agentSession("TheChomps"));
    expect(key).toBe(`agent:${WALLET}:thechomps`);
    // Never collides with the wallet bucket.
    expect(key).not.toBe(WALLET);
  });
});

describe("agentScopeFromSession", () => {
  it("returns null for a full human session", () => {
    expect(agentScopeFromSession(humanSession())).toBeNull();
  });

  it("returns the normalized scope for an agent session", () => {
    expect(agentScopeFromSession(agentSession("TheChomps"))).toEqual({
      address: WALLET,
      agent: "thechomps",
    });
  });
});
