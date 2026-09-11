/**
 * Session verification tests — EVM recovery, Hedera Ed25519/ECDSA (mocked
 * mirror node), message validation, and the nonce registry. No network.
 */
import { generateKeyPairSync, sign as cryptoSign } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  APP_NAME,
  SESSION_TTL_MS,
  buildSignInMessage,
  bytesToHex,
  generateNonce,
} from "../../session-message";
import {
  clearNonceRegistry,
  hederaSignedMessageBytes,
  issueSessionToken,
  testAuthPort,
  verifyEcdsaSecp256k1,
  verifyEd25519,
  type AccountKey,
  type SessionCredential,
} from "./auth";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const CHAIN_ID = 296;
const ORIGIN = "https://voicescape.app";

function msg(over: Record<string, unknown> = {}) {
  return buildSignInMessage({
    address: "0x1234567890abcdef1234567890abcdef12345678",
    chainId: CHAIN_ID,
    nonce: generateNonce(),
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + SESSION_TTL_MS).toISOString(),
    uri: ORIGIN,
    ...over,
  });
}

async function evmCred(
  over: Record<string, unknown> = {},
  signer?: { signMessage: (message: string) => Promise<string>; address: string },
): Promise<SessionCredential> {
  const w = signer ?? ethers.Wallet.createRandom();
  const message = msg({ address: w.address, ...over });
  return { message, signature: await w.signMessage(message) };
}

function port(keyMap: Record<string, AccountKey> = {}) {
  return testAuthPort({
    chainId: () => CHAIN_ID,
    nowMs: () => NOW,
    origin: () => ORIGIN,
    fetchAccountKey: async (id) => keyMap[id] ?? null,
  });
}

beforeEach(async () => {
  await clearNonceRegistry();
});

describe("EVM sessions", () => {
  it("accepts a valid personal_sign session", async () => {
    const p = port();
    const wallet = ethers.Wallet.createRandom();
    const cred = await evmCred({}, wallet);
    const r = await p.verifySession(cred);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.address).toBe(wallet.address.toLowerCase());
      expect(r.session.chainId).toBe(CHAIN_ID);
    }
  });

  it("rejects a signature from a different wallet", async () => {
    const p = port();
    const victim = ethers.Wallet.createRandom();
    const attacker = ethers.Wallet.createRandom();
    const message = msg({ address: victim.address });
    const r = await p.verifySession({ message, signature: await attacker.signMessage(message) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/signature/i);
  });

  it("rejects expired and wrong-chain messages", async () => {
    const p = port();
    const expired = await evmCred({ expiresAt: new Date(NOW - 1000).toISOString() });
    expect((await p.verifySession(expired)).ok).toBe(false);

    const wallet = ethers.Wallet.createRandom();
    const wrongChainMsg = msg({ address: wallet.address, chainId: 1 });
    const r = await p.verifySession({ message: wrongChainMsg, signature: await wallet.signMessage(wrongChainMsg) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/chain/i);
  });

  it("rejects missing/malformed credentials", async () => {
    const p = port();
    expect((await p.verifySession(null)).ok).toBe(false);
    expect((await p.verifySession({})).ok).toBe(false);
    expect((await p.verifySession({ message: "hello", signature: "0x1234" })).ok).toBe(false);
  });
});

describe("nonce registry (single-use-ish)", () => {
  it("allows the same session twice, rejects nonce reuse with a new signature", async () => {
    const p = port();
    const cred = await evmCred();
    expect((await p.verifySession(cred)).ok).toBe(true);
    // Same bearer session re-presented: fine.
    expect((await p.verifySession(cred)).ok).toBe(true);

    // Same nonce, different message/signature: rejected.
    const wallet = ethers.Wallet.createRandom();
    const nonce = cred.message.match(/Nonce: ([0-9a-f]{32})/)![1];
    const message2 = msg({ address: wallet.address, nonce });
    const r = await p.verifySession({ message: message2, signature: await wallet.signMessage(message2) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/nonce/i);
  });

  it("frees nonces after expiry (no unbounded growth, no false reuse)", async () => {
    const t0 = NOW;
    const mkPort = (now: number) =>
      testAuthPort({ chainId: () => CHAIN_ID, nowMs: () => now, origin: () => ORIGIN });
    const wallet = ethers.Wallet.createRandom();
    const nonce = generateNonce();
    const message = buildSignInMessage({
      address: wallet.address,
      chainId: CHAIN_ID,
      nonce,
      issuedAt: new Date(t0).toISOString(),
      expiresAt: new Date(t0 + 3600_000).toISOString(),
      uri: ORIGIN,
    });
    const cred = { message, signature: await wallet.signMessage(message) };
    expect((await mkPort(t0).verifySession(cred)).ok).toBe(true);
    // After expiry the stale entry is purged and the message is rejected as
    // expired (not as a nonce collision).
    const r = await mkPort(t0 + 3600_001).verifySession(cred);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/expired/);
  });
});

describe("origin binding (phishing replay)", () => {
  it("rejects a valid signature minted for a different site", async () => {
    const p = port();
    const wallet = ethers.Wallet.createRandom();
    // Attacker phishes the user into signing the same text on evil.example;
    // the signature is cryptographically valid but addressed elsewhere.
    const message = msg({ address: wallet.address, uri: "https://evil.example" });
    const r = await p.verifySession({ message, signature: await wallet.signMessage(message) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/different site/);
  });

  it("rejects a legacy message with no URI line", async () => {
    const p = port();
    const wallet = ethers.Wallet.createRandom();
    const message = msg({ address: wallet.address }).replace(/^URI: .*\n/m, "");
    const r = await p.verifySession({ message, signature: await wallet.signMessage(message) });
    expect(r.ok).toBe(false);
  });

  it("accepts the same credential when the origin check is unconfigured (dev)", async () => {
    const devPort = testAuthPort({
      chainId: () => CHAIN_ID,
      nowMs: () => NOW,
      origin: () => null,
      fetchAccountKey: async () => null,
    });
    const wallet = ethers.Wallet.createRandom();
    const message = msg({ address: wallet.address, uri: "http://localhost:3000" });
    const r = await devPort.verifySession({ message, signature: await wallet.signMessage(message) });
    expect(r.ok).toBe(true);
  });
});

describe("Hedera sessions (Ed25519)", () => {
  function hederaKey() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    // Export raw 32-byte public key like the mirror node returns.
    const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const raw = der.subarray(der.length - 32);
    return { publicKey, privateKey, rawHex: raw.toString("hex") };
  }

  async function hederaCred(
    accountId: string,
    priv: Parameters<typeof cryptoSign>[2],
    opts: { tamper?: boolean; raw?: boolean } = {},
  ) {
    const message = msg({ address: accountId });
    const what = opts.tamper ? message + "x" : message;
    // Realistic wallet flow: sign the "\x19Hedera Signed Message:" prefixed
    // bytes. `raw: true` covers wallets that sign the plain message bytes.
    const bytes = opts.raw ? new TextEncoder().encode(what) : hederaSignedMessageBytes(what);
    const sig = cryptoSign(null, Buffer.from(bytes), priv);
    return { message, signature: "0x" + sig.toString("hex") };
  }

  it("accepts a valid wallet signature via the mirror-node key", async () => {
    const { privateKey, rawHex } = hederaKey();
    const accountId = "0.0.12345";
    const p = port({ [accountId]: { keyHex: rawHex, keyType: "ED25519" } });
    const { message, signature } = await hederaCred(accountId, privateKey);
    const r = await p.verifySession({ message, signature });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.address).toBe("0x0000000000000000000000000000000000003039");
  });

  it("also accepts raw-bytes signatures (non-prefixed wallets)", async () => {
    const { privateKey, rawHex } = hederaKey();
    const accountId = "0.0.12345";
    const p = port({ [accountId]: { keyHex: rawHex, keyType: "ED25519" } });
    const { message, signature } = await hederaCred(accountId, privateKey, { raw: true });
    expect((await p.verifySession({ message, signature })).ok).toBe(true);
  });

  it("rejects tampered messages and unknown accounts", async () => {
    const { privateKey, rawHex } = hederaKey();
    const accountId = "0.0.12345";
    const p = port({ [accountId]: { keyHex: rawHex, keyType: "ED25519" } });
    const bad = await hederaCred(accountId, privateKey, { tamper: true });
    expect((await p.verifySession({ message: bad.message, signature: bad.signature })).ok).toBe(false);

    const p2 = port({});
    const good = await hederaCred(accountId, privateKey);
    const r2 = await p2.verifySession({ message: good.message, signature: good.signature });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/public key|mirror/i);
  });

  it("rejects non-Ed25519 keys instead of faking verification", async () => {
    const { privateKey, rawHex } = hederaKey();
    const accountId = "0.0.999";
    const p = port({ [accountId]: { keyHex: rawHex, keyType: "RSA" } });
    const { message, signature } = await hederaCred(accountId, privateKey);
    const r = await p.verifySession({ message, signature });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unsupported key type/i);
  });
});

describe("Hedera sessions (ECDSA secp256k1)", () => {
  function ecdsaKey() {
    const priv = secp256k1.utils.randomPrivateKey();
    const pubCompressed = secp256k1.getPublicKey(priv, true);
    const pubUncompressed = secp256k1.getPublicKey(priv, false);
    return {
      priv,
      compressedHex: Buffer.from(pubCompressed).toString("hex"),
      uncompressedHex: Buffer.from(pubUncompressed).toString("hex"),
    };
  }

  /** Mirror what a Hedera wallet does: sign keccak256(message) -> 64-byte compact (r||s). */
  function walletSign(messageBytes: Uint8Array, priv: Uint8Array): string {
    const sig = secp256k1.sign(keccak_256(messageBytes), priv).toCompactRawBytes();
    return "0x" + Buffer.from(sig).toString("hex");
  }

  async function ecdsaCred(
    accountId: string,
    priv: Uint8Array,
    opts: { raw?: boolean; tamper?: boolean } = {},
  ) {
    const message = msg({ address: accountId });
    const what = opts.tamper ? message + "x" : message;
    // Wallets sign the "\x19Hedera Signed Message:" prefixed bytes;
    // `raw: true` covers wallets that sign the plain message bytes.
    const bytes = opts.raw ? new TextEncoder().encode(what) : hederaSignedMessageBytes(what);
    return { message, signature: walletSign(bytes, priv) };
  }

  it("accepts an ECDSA_SECP256K1 wallet signature (compressed key)", async () => {
    const { priv, compressedHex } = ecdsaKey();
    const accountId = "0.0.10424063";
    const p = port({ [accountId]: { keyHex: compressedHex, keyType: "ECDSA_SECP256K1" } });
    const { message, signature } = await ecdsaCred(accountId, priv);
    const r = await p.verifySession({ message, signature });
    expect(r.ok).toBe(true);
  });

  it("accepts uncompressed 65-byte keys and raw-bytes signatures", async () => {
    const { priv, uncompressedHex } = ecdsaKey();
    const accountId = "0.0.10424063";
    const p = port({ [accountId]: { keyHex: uncompressedHex, keyType: "ECDSA_SECP256K1" } });
    const { message, signature } = await ecdsaCred(accountId, priv, { raw: true });
    expect((await p.verifySession({ message, signature })).ok).toBe(true);
  });

  it("rejects ECDSA signatures that do not match the wallet key", async () => {
    const { priv, compressedHex } = ecdsaKey();
    const other = ecdsaKey();
    const accountId = "0.0.10424063";
    const p = port({ [accountId]: { keyHex: other.compressedHex, keyType: "ECDSA_SECP256K1" } });
    const { message, signature } = await ecdsaCred(accountId, priv);
    const r = await p.verifySession({ message, signature });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not match/i);

    const bad = await ecdsaCred(accountId, priv, { tamper: true });
    const r2 = await p.verifySession({ message: bad.message, signature: bad.signature });
    expect(r2.ok).toBe(false);
  });
});

describe("verifyEcdsaSecp256k1", () => {
  it("round-trips with noble", () => {
    const priv = secp256k1.utils.randomPrivateKey();
    const pub = secp256k1.getPublicKey(priv, true);
    const message = new TextEncoder().encode("Voicescape test");
    const sig = secp256k1.sign(keccak_256(message), priv).toCompactRawBytes();
    expect(verifyEcdsaSecp256k1(message, sig, pub)).toBe(true);
    const bad = new Uint8Array(sig);
    bad[0] ^= 1;
    expect(verifyEcdsaSecp256k1(message, bad, pub)).toBe(false);
    expect(verifyEcdsaSecp256k1(message, new Uint8Array(10), pub)).toBe(false);
    expect(verifyEcdsaSecp256k1(message, sig, new Uint8Array(32))).toBe(false);
  });
});

describe("verifyEd25519", () => {
  it("round-trips with node crypto", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const raw = new Uint8Array(der.subarray(der.length - 32));
    const message = new TextEncoder().encode("Voicescape test");
    const sig = new Uint8Array(cryptoSign(null, message, privateKey));
    expect(verifyEd25519(message, sig, raw)).toBe(true);
    const bad = new Uint8Array(sig);
    bad[0] ^= 1;
    expect(verifyEd25519(message, bad, raw)).toBe(false);
    expect(verifyEd25519(message, new Uint8Array(10), raw)).toBe(false);
  });
});

describe("hederaSignedMessageBytes", () => {
  it("matches the @hashgraph/hedera-wallet-connect convention", () => {
    const out = new TextDecoder().decode(hederaSignedMessageBytes("hello"));
    expect(out).toBe("Hedera Signed Message:\n5hello");
  });
});

describe("message format sanity", () => {
  it("mentions the app name and address", () => {
    const m = msg();
    expect(m).toContain(APP_NAME);
    expect(bytesToHex(new Uint8Array([0xde, 0xad]))).toBe("dead");
  });
});

describe("stateless session tokens", () => {
  const SECRET = "test-secret-0123456789abcdef";
  const ADDR = "0x1234567890abcdef1234567890abcdef12345678";

  function portWithSecret(secret: string, chainId: number = CHAIN_ID) {
    process.env.SESSION_SECRET = secret;
    return testAuthPort({ chainId: () => chainId, nowMs: () => NOW, origin: () => ORIGIN });
  }

  // The top-level beforeEach clears the nonce registry; here we also
  // restore the secret env var after each token test.
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("round-trips: verifySession accepts a freshly issued token", async () => {
    const p = portWithSecret(SECRET);
    const cred = await evmCred();
    const login = await p.verifySession(cred);
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    const token = issueSessionToken(login.session, NOW);
    const r = await p.verifySession(token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.address).toBe(login.session.address);
      expect(r.session.chainId).toBe(CHAIN_ID);
      expect(r.session.nonce).toBe(login.session.nonce);
    }
  });

  it("rejects a tampered token body", async () => {
    const p = portWithSecret(SECRET);
    const token = issueSessionToken(
      { address: ADDR, chainId: CHAIN_ID, nonce: generateNonce(), expiresAtMs: NOW + 3600_000 },
      NOW,
    );
    const [body, sig] = token.split(".");
    const tamperedBody = body.slice(0, -2) + (body.slice(-2) === "AA" ? "BB" : "AA");
    const r = await p.verifySession(`${tamperedBody}.${sig}`);
    expect(r.ok).toBe(false);
  });

  it("rejects a token signed with a different secret", async () => {
    const p = portWithSecret(SECRET);
    const token = issueSessionToken(
      { address: ADDR, chainId: CHAIN_ID, nonce: generateNonce(), expiresAtMs: NOW + 3600_000 },
      NOW,
    );
    const p2 = portWithSecret("a-different-secret");
    const r = await p2.verifySession(token);
    expect(r.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const p = portWithSecret(SECRET);
    const token = issueSessionToken(
      { address: ADDR, chainId: CHAIN_ID, nonce: generateNonce(), expiresAtMs: NOW - 1 },
      NOW - 10_000,
    );
    const r = await p.verifySession(token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/expired/);
  });

  it("rejects a token whose lifetime exceeds 7 days", async () => {
    const p = portWithSecret(SECRET);
    const token = issueSessionToken(
      { address: ADDR, chainId: CHAIN_ID, nonce: generateNonce(), expiresAtMs: NOW + SESSION_TTL_MS * 2 },
      NOW,
    );
    const r = await p.verifySession(token);
    expect(r.ok).toBe(false);
  });

  it("rejects a token minted for a different chain", async () => {
    const p296 = portWithSecret(SECRET, 296);
    const token = issueSessionToken(
      { address: ADDR, chainId: 1, nonce: generateNonce(), expiresAtMs: NOW + 3600_000 },
      NOW,
    );
    const r = await p296.verifySession(token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/wrong chain/);
  });

  it("works across fresh port instances (no shared memory)", async () => {
    const p1 = portWithSecret(SECRET); // sets SESSION_SECRET before issuance
    const token = issueSessionToken(
      { address: ADDR, chainId: CHAIN_ID, nonce: generateNonce(), expiresAtMs: NOW + 3600_000 },
      NOW,
    );
    const a = await p1.verifySession(token);
    const b = await portWithSecret(SECRET).verifySession(token);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });
});
