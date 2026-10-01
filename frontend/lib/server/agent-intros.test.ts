/**
 * Tests for the agent-intros core (lib/server/agent-intros.ts).
 * All persistence is a fake in-memory KvStore — no network, no real store.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { KvStore } from "./store";
import {
  postAgentIntro,
  listAgentIntros,
  claimAgentIntro,
  textHasUrl,
  validateIntroInput,
  normalizeClaimCode,
  hashClientIp,
} from "./agent-intros";

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
    for (const k of [...this.data.keys()]) {
      if (k.startsWith(prefix)) this.data.delete(k);
    }
  }
}

let store: FakeStore;
beforeEach(() => {
  store = new FakeStore();
});

describe("textHasUrl", () => {
  it("rejects http/https links", () => {
    expect(textHasUrl("see http://example.com for more")).toBe(true);
    expect(textHasUrl("see https://example.com for more")).toBe(true);
  });
  it("rejects www. links", () => {
    expect(textHasUrl("visit www.example.com today")).toBe(true);
  });
  it("rejects bare domains", () => {
    expect(textHasUrl("find me at example.com")).toBe(true);
    expect(textHasUrl("my site: foo.bar.io")).toBe(true);
  });
  it("accepts plain text without links", () => {
    expect(textHasUrl("I build trading bots on Hedera")).toBe(false);
    expect(textHasUrl("version 2.0 is coming soon")).toBe(false);
  });
});

describe("validateIntroInput", () => {
  it("accepts a valid handle and text", () => {
    const r = validateIntroInput("Forge_2", "Hello, I build things.");
    expect(r.ok).toBe(true);
  });
  it("lowercases handles", () => {
    const r = validateIntroInput("FORGE", "hi");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.handle).toBe("forge");
  });
  it("rejects bad handles", () => {
    for (const h of ["ab", "a".repeat(33), "has space", "UPPER!", "dots.here"]) {
      expect(validateIntroInput(h, "hi").ok).toBe(false);
    }
  });
  it("enforces the 280-char limit", () => {
    expect(validateIntroInput("forge", "x".repeat(280)).ok).toBe(true);
    expect(validateIntroInput("forge", "x".repeat(281)).ok).toBe(false);
  });
  it("rejects empty text", () => {
    expect(validateIntroInput("forge", "   ").ok).toBe(false);
  });
  it("rejects text with links", () => {
    const r = validateIntroInput("forge", "check https://x.com/me");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/can't include links/i);
  });
});

describe("postAgentIntro", () => {
  it("posts a valid intro and returns a claim code", async () => {
    const r = await postAgentIntro(
      { handle: "forge", text: "I build on Hedera.", clientIp: "1.2.3.4" },
      store,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intro.claim_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(r.intro.handle).toBe("forge");
    expect(r.intro.linked_blockpage).toBeNull();
    expect(r.intro.created_at).toBeTruthy();
    // raw IP is never stored
    expect(r.intro.ip_hash).not.toContain("1.2.3.4");
    expect(r.intro.ip_hash).toBe(hashClientIp("1.2.3.4"));
  });

  it("enforces one intro per IP per day", async () => {
    const args = { handle: "forge", text: "first", clientIp: "5.6.7.8" };
    expect((await postAgentIntro(args, store)).ok).toBe(true);
    const second = await postAgentIntro(
      { handle: "other", text: "second", clientIp: "5.6.7.8" },
      store,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/one intro per day/i);
  });

  it("allows different IPs to post", async () => {
    expect(
      (await postAgentIntro({ handle: "a1x", text: "hi", clientIp: "1.1.1.1" }, store)).ok,
    ).toBe(true);
    expect(
      (await postAgentIntro({ handle: "b2y", text: "hi", clientIp: "2.2.2.2" }, store)).ok,
    ).toBe(true);
  });

  it("rejects intros with links", async () => {
    const r = await postAgentIntro(
      { handle: "forge", text: "see my work at example.com", clientIp: "3.3.3.3" },
      store,
    );
    expect(r.ok).toBe(false);
  });

  it("generates unique claim codes across many intros", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const r = await postAgentIntro(
        { handle: `agent${i}`, text: `intro ${i}`, clientIp: `10.0.0.${i}` },
        store,
      );
      expect(r.ok).toBe(true);
      if (r.ok) codes.add(r.intro.claim_code);
    }
    expect(codes.size).toBe(25);
  });
});

describe("listAgentIntros", () => {
  it("returns intros newest-first", async () => {
    await postAgentIntro({ handle: "aaa", text: "first", clientIp: "1.0.0.1" }, store);
    await postAgentIntro({ handle: "bbb", text: "second", clientIp: "1.0.0.2" }, store);
    const list = await listAgentIntros(store);
    expect(list.map((i) => i.handle)).toEqual(["bbb", "aaa"]);
  });

  it("returns an empty list when nothing was posted", async () => {
    expect(await listAgentIntros(store)).toEqual([]);
  });
});

describe("claimAgentIntro", () => {
  it("links an intro to a blockpage username", async () => {
    const posted = await postAgentIntro(
      { handle: "forge", text: "hi", clientIp: "9.9.9.9" },
      store,
    );
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    const claimed = await claimAgentIntro(posted.intro.claim_code, "Forge", store);
    expect(claimed.ok).toBe(true);
    if (claimed.ok) expect(claimed.intro.linked_blockpage).toBe("forge");
  });

  it("accepts the code without the dash", async () => {
    const posted = await postAgentIntro(
      { handle: "dash", text: "hi", clientIp: "9.9.9.8" },
      store,
    );
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    const noDash = posted.intro.claim_code.replace("-", "");
    const claimed = await claimAgentIntro(noDash, "somepage", store);
    expect(claimed.ok).toBe(true);
  });

  it("rejects unknown codes", async () => {
    const r = await claimAgentIntro("ZZZZ-YYYY", "somepage", store);
    expect(r.ok).toBe(false);
  });

  it("rejects double-linking", async () => {
    const posted = await postAgentIntro(
      { handle: "dblx", text: "hi", clientIp: "9.9.9.7" },
      store,
    );
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect((await claimAgentIntro(posted.intro.claim_code, "pageone", store)).ok).toBe(true);
    const again = await claimAgentIntro(posted.intro.claim_code, "pagetwo", store);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/already linked/i);
  });
});

describe("normalizeClaimCode", () => {
  it("uppercases and inserts the dash", () => {
    expect(normalizeClaimCode("ab12cd34")).toBe("AB12-CD34");
    expect(normalizeClaimCode("ab12-cd34")).toBe("AB12-CD34");
  });
});
