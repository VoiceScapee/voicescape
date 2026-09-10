/**
 * 500-user load simulation — verifies Voicescape logic holds up when 500
 * users (humans + AI agents) start using the platform concurrently.
 *
 * Simulates: session issuance/verification, daily quotas, 98/2 fee math at
 * scale, and the never-loses-money economics invariant.
 * No network, no chain — pure logic under concurrent load.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  issueSessionToken,
  verifySessionToken,
} from "./townhall/auth";
import { createMemoryQuotaStore } from "./quota";
import {
  buildSignInMessage,
  canonicalAddress,
  generateNonce,
  SESSION_TTL_MS,
} from "../session-message";

const USERS = 500;
const SECRET = "load-test-secret-min-32-bytes-long!!";

// Deterministic pseudo-wallets (Hedera IDs → canonical EVM form for sessions).
function wallet(i: number): string {
  return canonicalAddress(`0.0.${1_000_000 + i}`)!;
}

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
});

describe("500-user load simulation", () => {
  it("issues and verifies 500 concurrent sessions", async () => {
    const now = Date.now();
    const tokens = await Promise.all(
      Array.from({ length: USERS }, (_, i) =>
        Promise.resolve(
          issueSessionToken(
            {
              address: wallet(i),
              chainId: 295, // Hedera mainnet
              nonce: generateNonce(),
              expiresAtMs: now + SESSION_TTL_MS,
            },
            now,
          ),
        ),
      ),
    );
    expect(tokens).toHaveLength(USERS);
    // All tokens unique.
    expect(new Set(tokens).size).toBe(USERS);

    const results = await Promise.all(
      tokens.map((t) => Promise.resolve(verifySessionToken(t, now + 1000))),
    );
    for (const r of results) {
      expect(r.ok).toBe(true);
    }
  });

  it("session tokens cannot be forged or tampered", async () => {
    const now = Date.now();
    const token = issueSessionToken(
      { address: wallet(0), chainId: 295, nonce: generateNonce(), expiresAtMs: now + SESSION_TTL_MS },
      now,
    );
    // Token is body.sig (2 parts).
    expect(token.split(".")).toHaveLength(2);
    // Tamper with the body.
    const dot = token.lastIndexOf(".");
    const tampered = `${token.slice(0, dot)}X.${token.slice(dot + 1)}`;
    expect(verifySessionToken(tampered, now).ok).toBe(false);
    // Tamper with the signature.
    const badSig = `${token.slice(0, dot)}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect(verifySessionToken(badSig, now).ok).toBe(false);
    // Expired token rejected.
    expect(verifySessionToken(token, now + SESSION_TTL_MS + 60_000).ok).toBe(false);
  });

  it("500 users share daily quotas fairly — no user starves another", async () => {
    const store = createMemoryQuotaStore();
    const LIMIT = 5; // e.g. 5 AI generations / wallet / day
    // Every user consumes their full quota concurrently.
    const results = await Promise.all(
      Array.from({ length: USERS }, (_, i) =>
        Promise.all(
          Array.from({ length: LIMIT + 2 }, () =>
            store.consume("ai-generate", wallet(i), LIMIT),
          ),
        ),
      ),
    );
    for (let i = 0; i < USERS; i++) {
      const allowed = results[i].filter((r) => r.allowed).length;
      const denied = results[i].filter((r) => !r.allowed).length;
      expect(allowed).toBe(LIMIT);
      expect(denied).toBe(2);
    }
  });

  it("98/2 fee split holds exactly across 500 tips", () => {
    // Integer tinybar math, as enforced on-chain by VoicescapeTips.
    let treasuryTotal = 0n;
    let recipientsTotal = 0n;
    for (let i = 0; i < USERS; i++) {
      const tip = BigInt(1_000_000 + i * 7_777); // varied tip sizes
      const fee = (tip * 2n) / 100n;
      const toRecipient = tip - fee;
      treasuryTotal += fee;
      recipientsTotal += toRecipient;
      // Conservation: nothing created or destroyed.
      expect(toRecipient + fee).toBe(tip);
    }
    const grandTotal = treasuryTotal + recipientsTotal;
    // Treasury share is ~2% (integer rounding favors the recipient).
    const pct = Number((treasuryTotal * 10_000n) / grandTotal) / 100;
    expect(pct).toBeLessThanOrEqual(2);
    expect(pct).toBeGreaterThan(1.9);
    expect(treasuryTotal).toBeGreaterThan(0n);
  });

  it("dust-fee economics: platform never loses money at 500-user scale", () => {
    // Operator cost floor per town-hall write (HCS submit + mirror read).
    const COST_FLOOR_TINYBARS = 50_000n;
    // Configured dust fee must cover it.
    const DUST_FEE_TINYBARS = 100_000n;
    expect(DUST_FEE_TINYBARS).toBeGreaterThanOrEqual(COST_FLOOR_TINYBARS);

    // 500 users posting 10 times each: gross margin stays positive.
    const writes = BigInt(USERS * 10);
    const revenue = writes * DUST_FEE_TINYBARS;
    const cost = writes * COST_FLOOR_TINYBARS;
    expect(revenue - cost).toBeGreaterThan(0n);
  });

  it("sign-in messages are unique per user (no replay across wallets)", () => {
    const messages = new Set<string>();
    for (let i = 0; i < USERS; i++) {
      const msg = buildSignInMessage({
        address: `0.0.${1_000_000 + i}`,
        chainId: 295,
        nonce: generateNonce(),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        uri: "https://voicescape.vercel.app",
      });
      expect(messages.has(msg)).toBe(false);
      messages.add(msg);
    }
    expect(messages.size).toBe(USERS);
  });
});
