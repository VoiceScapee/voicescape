/**
 * Session message tests — construction, parsing, validation, header
 * transport, and the pure session lifecycle helpers. No network.
 */
import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import {
  APP_NAME,
  SESSION_TTL_MS,
  SignInRequired,
  buildSignInMessage,
  bytesToHex,
  canonicalAddress,
  createSession,
  decodeCredential,
  encodeCredential,
  generateNonce,
  hexToBytes,
  isHederaAccountId,
  normalizeOrigin,
  parseSignInMessage,
  restoreSession,
  serializeSession,
  validateSignInMessage,
  verifyEvmSignature,
} from "./session-message";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const ORIGIN = "https://voicescape.app";

function fields(over: Partial<Parameters<typeof buildSignInMessage>[0]> = {}) {
  return {
    address: "0x1234567890abcdef1234567890abcdef12345678",
    chainId: 296,
    nonce: "abcdef0123456789abcdef0123456789",
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + SESSION_TTL_MS).toISOString(),
    uri: ORIGIN,
    ...over,
  };
}

describe("build/parse round-trip", () => {
  it("parses what it builds", () => {
    const f = fields();
    const parsed = parseSignInMessage(buildSignInMessage(f));
    expect(parsed).toEqual(f);
  });

  it("supports Hedera account ids", () => {
    const f = fields({ address: "0.0.12345" });
    expect(parseSignInMessage(buildSignInMessage(f))).toEqual(f);
  });

  it("rejects tampered messages", () => {
    const msg = buildSignInMessage(fields());
    expect(parseSignInMessage(msg.replace("Chain ID: 296", "Chain ID: 297"))?.chainId).toBe(297); // parses…
    // …but a message with a mismatched Address line is rejected
    expect(parseSignInMessage(msg.replace(/^0x[0-9a-f]{40}$/m, "0x" + "00".repeat(20)))).toBeNull();
    // wrong header
    expect(parseSignInMessage(msg.replace(APP_NAME, "EvilApp"))).toBeNull();
    // extra line without colon
    expect(parseSignInMessage(msg + "\nno-colon-here")).toBeNull();
  });
});

describe("validateSignInMessage", () => {
  it("accepts a fresh message", () => {
    const r = validateSignInMessage(buildSignInMessage(fields()), { expectedChainId: 296, nowMs: NOW });
    expect(r.ok).toBe(true);
  });

  it("rejects wrong chain, expired, future-dated, bad nonce, wrong app", () => {
    const base = fields();
    expect(
      validateSignInMessage(buildSignInMessage(base), { expectedChainId: 295, nowMs: NOW }).ok,
    ).toBe(false);
    expect(
      validateSignInMessage(buildSignInMessage({ ...base, expiresAt: new Date(NOW - 1000).toISOString() }), {
        expectedChainId: 296,
        nowMs: NOW,
      }).reason,
    ).toMatch(/expired/);
    expect(
      validateSignInMessage(buildSignInMessage({ ...base, issuedAt: new Date(NOW + 3600_000).toISOString() }), {
        expectedChainId: 296,
        nowMs: NOW,
      }).reason,
    ).toMatch(/future/);
    expect(
      validateSignInMessage(buildSignInMessage({ ...base, nonce: "short" }), {
        expectedChainId: 296,
        nowMs: NOW,
      }).reason,
    ).toMatch(/nonce/);
    expect(
      validateSignInMessage(buildSignInMessage(base).replace("App: Voicescape", "App: Evil"), {
        expectedChainId: 296,
        nowMs: NOW,
      }).reason,
    ).toMatch(/Voicescape/);
    expect(
      validateSignInMessage(buildSignInMessage({ ...base, address: "not-an-address" }), {
        expectedChainId: 296,
        nowMs: NOW,
      }).reason,
    ).toMatch(/address/);
  });

  it("rejects over-long lifetimes", () => {
    const r = validateSignInMessage(
      buildSignInMessage(fields({ expiresAt: new Date(NOW + 30 * 24 * 3600_1000).toISOString() })),
      { expectedChainId: 296, nowMs: NOW },
    );
    expect(r.ok).toBe(false);
  });
});

describe("origin binding (EIP-4361 uri)", () => {
  const opts = { expectedChainId: 296, nowMs: NOW, expectedOrigin: ORIGIN };

  it("accepts a message addressed to this origin", () => {
    expect(validateSignInMessage(buildSignInMessage(fields()), opts).ok).toBe(true);
  });

  it("rejects a signature minted for a different site (phishing replay)", () => {
    const r = validateSignInMessage(buildSignInMessage(fields({ uri: "https://evil.example" })), opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/different site/);
  });

  it("normalizes case and trailing slashes before comparing", () => {
    const r = validateSignInMessage(buildSignInMessage(fields({ uri: "HTTPS://Voicescape.APP/" })), opts);
    expect(r.ok).toBe(true);
    expect(normalizeOrigin("HTTPS://Voicescape.APP/")).toBe("https://voicescape.app");
  });

  it("skips the check when the server has no origin configured (dev)", () => {
    const r = validateSignInMessage(buildSignInMessage(fields({ uri: "http://localhost:3000" })), {
      expectedChainId: 296,
      nowMs: NOW,
      expectedOrigin: null,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a message with the URI line stripped", () => {
    const msg = buildSignInMessage(fields()).replace(/^URI: .*\n/m, "");
    expect(parseSignInMessage(msg)).toBeNull();
    expect(validateSignInMessage(msg, opts).ok).toBe(false);
  });
});

describe("evm signature round-trip", () => {
  it("recovers the signer address", async () => {
    const wallet = ethers.Wallet.createRandom();
    const msg = buildSignInMessage(fields({ address: wallet.address, chainId: 80002 }));
    const sig = await wallet.signMessage(msg);
    expect(verifyEvmSignature(msg, sig, wallet.address)).toBe(true);
    expect(verifyEvmSignature(msg, sig, "0x0000000000000000000000000000000000000001")).toBe(false);
    expect(verifyEvmSignature(msg + "tampered", sig, wallet.address)).toBe(false);
  });
});

describe("canonicalAddress", () => {
  it("normalizes both families", () => {
    expect(canonicalAddress("0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD")).toBe(
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    );
    expect(canonicalAddress("0.0.12345")).toBe("0x0000000000000000000000000000000000003039");
    expect(canonicalAddress("0.0.0")).toBe("0x0000000000000000000000000000000000000000");
    expect(canonicalAddress("nope")).toBeNull();
  });

  it("isHederaAccountId", () => {
    expect(isHederaAccountId("0.0.7")).toBe(true);
    expect(isHederaAccountId("0x1234567890abcdef1234567890abcdef12345678")).toBe(false);
  });
});

describe("header transport", () => {
  it("encodes/decodes a credential", () => {
    const cred = { message: "hello\nmultiline ✓", signature: "0xdeadbeef" };
    const enc = encodeCredential(cred);
    expect(enc).not.toContain("+");
    expect(enc).not.toContain("/");
    expect(decodeCredential(enc)).toEqual(cred);
  });

  it("rejects garbage", () => {
    expect(decodeCredential(null)).toBeNull();
    expect(decodeCredential("!!!")).toBeNull();
    expect(decodeCredential(encodeCredential({ message: "m", signature: "not-hex" }))).toBeNull();
  });
});

describe("session lifecycle (pure)", () => {
  function makeSession(overrides: Partial<ReturnType<typeof createSession>> = {}) {
    return createSession({
      token: "tok_test_abc123",
      address: "0x000000000000000000000000000000000000b001",
      chainId: 296,
      adapterId: "metamask",
      expiresAtMs: NOW + SESSION_TTL_MS,
      ...overrides,
    });
  }

  it("persists and restores", () => {
    const s = makeSession();
    const { session, reason } = restoreSession(serializeSession(s), NOW);
    expect(reason).toBeUndefined();
    expect(session?.token).toBe(s.token);
    expect(session?.address).toBe(s.address);
  });

  it("expires honestly", () => {
    const s = makeSession();
    const r = restoreSession(serializeSession(s), NOW + SESSION_TTL_MS + 1000);
    expect(r.session).toBeNull();
    expect(r.reason).toBe("expired");
  });

  it("rejects a tokenless payload", () => {
    const s = makeSession();
    const tampered = { ...s, token: "" };
    const r = restoreSession(serializeSession(tampered), NOW);
    expect(r.session).toBeNull();
    expect(r.reason).toBe("corrupt");
  });

  it("rejects corrupt payloads", () => {
    expect(restoreSession(null).session).toBeNull();
    expect(restoreSession("{bad json").reason).toBe("corrupt");
  });

  it("refuses to create a session without a token", () => {
    expect(() =>
      createSession({
        token: "",
        address: "0x000000000000000000000000000000000000b001",
        chainId: 296,
        adapterId: "metamask",
        expiresAtMs: NOW + 1000,
      }),
    ).toThrow(/token/);
  });

  it("SignInRequired is an Error", () => {
    const e = new SignInRequired();
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toMatch(/sign in/i);
  });

  it("generateNonce / hex helpers", () => {
    const n = generateNonce();
    expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(generateNonce()).not.toBe(n);
    const bytes = hexToBytes("0xdeadBEEF");
    expect(bytesToHex(bytes)).toBe("deadbeef");
    expect(() => hexToBytes("0xzz")).toThrow();
  });
});
