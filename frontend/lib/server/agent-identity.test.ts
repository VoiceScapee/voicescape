/**
 * Tests for the agent identity continuity core (lib/server/agent-identity.ts).
 * KV is a fake in-memory store. Key generation and signing use the real
 * @hiero-ledger/sdk — the verification path under test is the production one.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PrivateKey } from "@hiero-ledger/sdk";
import type { KvStore } from "./store";
import {
  getIdentity,
  parseIdentityKey,
  registerIdentityKey,
  rotateIdentityKey,
  rotationMessage,
} from "./agent-identity";
import { postAgentIntro } from "./agent-intros";

class FakeStore implements KvStore {
  private data = new Map<string, { value: string; expiresAt: number }>();
  private alive(key: string): boolean {
    const e = this.data.get(key);
    if (!e) return false;
    if (e.expiresAt <= Date.now()) {
      this.data.delete(key);
      return false;
    }
    return true;
  }
  async incr(key: string, ttlMs: number): Promise<number> {
    const cur = this.alive(key) ? Number(this.data.get(key)!.value) : 0;
    const next = cur + 1;
    this.data.set(key, { value: String(next), expiresAt: Date.now() + ttlMs });
    return next;
  }
  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.alive(key)) return false;
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
    return true;
  }
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
  async get(key: string): Promise<string | null> {
    return this.alive(key) ? this.data.get(key)!.value : null;
  }
  async del(key: string): Promise<void> {
    this.data.delete(key);
  }
  async clearPrefix(prefix: string): Promise<void> {
    for (const k of [...this.data.keys()]) if (k.startsWith(prefix)) this.data.delete(k);
  }
}

function genKey(): { priv: PrivateKey; hex: string } {
  const priv = PrivateKey.generateED25519();
  return { priv, hex: priv.publicKey.toStringRaw() };
}

/** Post an intro for `handle` and return its claim code. */
async function introClaimCode(store: FakeStore, handle: string): Promise<string> {
  const r = await postAgentIntro({ handle, text: "test agent", clientIp: `10.0.0.${Math.floor(Math.random() * 200) + 1}` }, store);
  if (!r.ok) throw new Error(`intro failed: ${r.error}`);
  return r.intro.claim_code;
}

describe("agent identity continuity", () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it("registers the first key with a valid claim code", async () => {
    const code = await introClaimCode(store, "testagent");
    const { hex } = genKey();
    const r = await registerIdentityKey({ handle: "testagent", claimCode: code, publicKey: hex }, store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity.current_key).toBe(hex);
    expect(r.identity.keys).toHaveLength(1);
    expect(r.identity.keys[0].rotated_from).toBeNull();
  });

  it("refuses registration with a wrong claim code", async () => {
    await introClaimCode(store, "testagent");
    const { hex } = genKey();
    const r = await registerIdentityKey({ handle: "testagent", claimCode: "ZZZZ-ZZZZ", publicKey: hex }, store);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("bad-claim-code");
  });

  it("refuses registration when the claim code belongs to another handle", async () => {
    const code = await introClaimCode(store, "otheragent");
    const { hex } = genKey();
    const r = await registerIdentityKey({ handle: "testagent", claimCode: code, publicKey: hex }, store);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("handle-mismatch");
  });

  it("refuses a second registration — rotation is the only path forward", async () => {
    const code = await introClaimCode(store, "testagent");
    const k1 = genKey();
    const k2 = genKey();
    expect((await registerIdentityKey({ handle: "testagent", claimCode: code, publicKey: k1.hex }, store)).ok).toBe(true);
    const r = await registerIdentityKey({ handle: "testagent", claimCode: code, publicKey: k2.hex }, store);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("already-registered");
  });

  it("rotates with a valid signature from the current key, chaining the history", async () => {
    const code = await introClaimCode(store, "testagent");
    const k1 = genKey();
    const k2 = genKey();
    await registerIdentityKey({ handle: "testagent", claimCode: code, publicKey: k1.hex }, store);
    const sig = Buffer.from(k1.priv.sign(Buffer.from(rotationMessage("testagent", k2.hex), "utf8"))).toString("hex");
    const r = await rotateIdentityKey({ handle: "testagent", newPublicKey: k2.hex, signature: sig }, store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity.current_key).toBe(k2.hex);
    expect(r.identity.keys).toHaveLength(2);
    expect(r.identity.keys[1].rotated_from).toBe(k1.hex);

    // A third rotation must be signed by k2 now, not k1.
    const k3 = genKey();
    const staleSig = Buffer.from(k1.priv.sign(Buffer.from(rotationMessage("testagent", k3.hex), "utf8"))).toString("hex");
    const stale = await rotateIdentityKey({ handle: "testagent", newPublicKey: k3.hex, signature: staleSig }, store);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error).toBe("bad-signature");
  });

  it("refuses rotation signed by the wrong key", async () => {
    const code = await introClaimCode(store, "testagent");
    const k1 = genKey();
    const k2 = genKey();
    const attacker = genKey();
    await registerIdentityKey({ handle: "testagent", claimCode: code, publicKey: k1.hex }, store);
    const sig = Buffer.from(attacker.priv.sign(Buffer.from(rotationMessage("testagent", k2.hex), "utf8"))).toString("hex");
    const r = await rotateIdentityKey({ handle: "testagent", newPublicKey: k2.hex, signature: sig }, store);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("bad-signature");
    // Identity untouched.
    expect((await getIdentity("testagent", store))?.current_key).toBe(k1.hex);
  });

  it("refuses rotation to the already-current key", async () => {
    const code = await introClaimCode(store, "testagent");
    const k1 = genKey();
    await registerIdentityKey({ handle: "testagent", claimCode: code, publicKey: k1.hex }, store);
    const sig = Buffer.from(k1.priv.sign(Buffer.from(rotationMessage("testagent", k1.hex), "utf8"))).toString("hex");
    const r = await rotateIdentityKey({ handle: "testagent", newPublicKey: k1.hex, signature: sig }, store);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("key-reuse");
  });

  it("getIdentity returns null for unregistered handles", async () => {
    expect(await getIdentity("nobody", store)).toBeNull();
  });

  it("rejects malformed keys without touching crypto", async () => {
    expect(parseIdentityKey("not-hex").ok).toBe(false);
    expect(parseIdentityKey("ab".repeat(31)).ok).toBe(false); // 62 chars
    expect(parseIdentityKey("zz".repeat(32)).ok).toBe(false); // non-hex
    const { hex } = genKey();
    expect(parseIdentityKey(hex).ok).toBe(true);
  });
});
