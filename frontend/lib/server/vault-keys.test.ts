/**
 * Tests for vault-keys: mirror-key parsing, hostile-shape rejection,
 * agent key normalization, fingerprints. No network — pure SDK work.
 */
import { describe, it, expect } from "vitest";
import { PrivateKey } from "@hiero-ledger/sdk";
import {
  humanKeyFromMirrorAccount,
  normalizeAgentPublicKey,
  keyFingerprint,
  canonicalKeyHex,
} from "./vault-keys";

const A = PrivateKey.generateED25519();
const B = PrivateKey.generateECDSA();
const aHex = A.publicKey.toStringRaw().toLowerCase();
const bHex = B.publicKey.toStringRaw().toLowerCase();

describe("humanKeyFromMirrorAccount — happy paths", () => {
  it("accepts a simple ED25519 key", () => {
    const r = humanKeyFromMirrorAccount({ key: { _type: "ED25519", key: aHex } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.keyType).toBe("ED25519");
      expect(r.keyHex).toBe(aHex);
      expect(r.publicKey.toStringRaw().toLowerCase()).toBe(aHex);
    }
  });

  it("accepts a simple ECDSA key", () => {
    const r = humanKeyFromMirrorAccount({ key: { _type: "ECDSA_SECP256K1", key: bHex } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.keyType).toBe("ECDSA_SECP256K1");
      expect(r.keyHex).toBe(bHex);
    }
  });
});

describe("humanKeyFromMirrorAccount — rejections with plain-words guidance", () => {
  it("rejects a hollow account", () => {
    const r = humanKeyFromMirrorAccount({ key: null });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("hollow account");
      expect(r.guidance).toContain("hasn't made its first transaction");
    }
  });

  it("rejects a contract-style body with no key", () => {
    const r = humanKeyFromMirrorAccount({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("hollow account");
  });

  it("rejects an opaque ProtobufEncoded key", () => {
    const r = humanKeyFromMirrorAccount({ key: { _type: "ProtobufEncoded", key: "aabbcc" } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("unsupported account key");
      expect(r.guidance).toContain("normal wallet account");
    }
  });

  it("rejects garbage key bytes", () => {
    const r = humanKeyFromMirrorAccount({ key: { _type: "ED25519", key: "zz-not-hex" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unreadable account key");
  });

  it("rejects multisig shapes outright — even a single-key ThresholdKey", () => {
    const r = humanKeyFromMirrorAccount({
      key: {
        _type: "ThresholdKey",
        threshold: 1,
        keys: [{ _type: "ED25519", key: aHex }],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("multisig account");
      expect(r.guidance).toContain("single-key account");
    }
  });

  it("rejects a 2-key KeyList", () => {
    const r = humanKeyFromMirrorAccount({
      key: {
        _type: "KeyList",
        keys: [
          { _type: "ED25519", key: aHex },
          { _type: "ED25519", key: PrivateKey.generateED25519().publicKey.toStringRaw().toLowerCase() },
        ],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("multisig account");
  });
});

describe("normalizeAgentPublicKey", () => {
  it("accepts a valid 64-hex ED25519 key (0x optional)", () => {
    expect(normalizeAgentPublicKey(aHex)).toEqual({ ok: true, keyHex: aHex });
    expect(normalizeAgentPublicKey("0x" + aHex.toUpperCase())).toEqual({
      ok: true,
      keyHex: aHex,
    });
  });

  it("rejects non-ED25519 and malformed input", () => {
    expect(normalizeAgentPublicKey(bHex).ok).toBe(false); // ECDSA
    expect(normalizeAgentPublicKey("xyz").ok).toBe(false);
    expect(normalizeAgentPublicKey("0".repeat(64)).ok).toBe(false); // invalid curve point
    expect(normalizeAgentPublicKey(123 as unknown as string).ok).toBe(false);
  });

  it("error messages are plain words", () => {
    const r = normalizeAgentPublicKey("xyz");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("hex");
  });
});

describe("keyFingerprint + canonicalKeyHex", () => {
  it("renders the a3f9…e7b4 shape", () => {
    const fp = keyFingerprint(aHex);
    expect(fp).toBe(`${aHex.slice(0, 8)}…${aHex.slice(-8)}`);
    expect(fp).toContain("…");
  });

  it("canonicalizes through the SDK (same hex both paths)", () => {
    expect(canonicalKeyHex("ED25519", aHex.toUpperCase())).toBe(aHex);
    expect(canonicalKeyHex("ED25519", "zz")).toBeNull();
    expect(canonicalKeyHex("ProtobufEncoded", "aabb")).toBeNull();
  });
});
