/**
 * Blockpage chat handler tests.
 *
 * Model under test: anyone can chat with a username (no wallet); the page
 * owner (on-chain registry) and promoted mods filter. Mod powers are bound
 * to wallet addresses so they can't be spoofed by picking a username.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createMemoryKvStore, type KvStore } from "../store";
import {
  defaultPageChatDeps,
  listPageChat,
  moderatePageChat,
  pageChatRole,
  postPageChat,
  type PageChatDeps,
} from "./handlers";

const OWNER = "0x0000000000000000000000000000000000000abc";
const MOD = "0x0000000000000000000000000000000000000def";
const VIEWER = "0x0000000000000000000000000000000000000123";

function deps(): PageChatDeps {
  const store: KvStore = createMemoryKvStore();
  return {
    store,
    registry: {
      resolveOwner: async (u: string) => (u === "ash-rook" ? OWNER : null),
    },
    mirror: {
      // identity: every address resolves to itself
      resolveAccountId: async (a: string) => a,
    },
    auth: {
      verifySession: async (cred: unknown) => {
        const table: Record<string, string> = {
          "tok-owner": OWNER,
          "tok-mod": MOD,
          "tok-viewer": VIEWER,
        };
        const addr = typeof cred === "string" ? table[cred] : undefined;
        if (!addr) return { ok: false as const, error: "bad session" };
        return {
          ok: true as const,
          session: { address: addr, chainId: 296, nonce: "n", expiresAtMs: Date.now() + 60000 },
        };
      },
    },
  };
}

describe("postPageChat", () => {
  let d: PageChatDeps;
  beforeEach(() => {
    d = deps();
  });

  it("lets anyone chat with a username, no wallet", async () => {
    const r = await postPageChat(d, "ash-rook", { name: "  StreamFan42 ", body: "hello!" }, "1.2.3.4");
    expect(r.status).toBe(201);
    const msg = (r.json as { message: { name: string; wallet: null } }).message;
    expect(msg.name).toBe("StreamFan42");
    expect(msg.wallet).toBeNull();
  });

  it("marks wallet-verified chatters", async () => {
    const r = await postPageChat(
      d,
      "ash-rook",
      { name: "Ash", body: "hi", auth: "tok-owner" },
      "1.2.3.4",
    );
    expect(r.status).toBe(201);
    expect((r.json as { message: { wallet: string } }).message.wallet).toBe(OWNER);
  });

  it("404s on unregistered pages (no room squatting)", async () => {
    const r = await postPageChat(d, "nobody-here", { name: "x", body: "hi" }, "1.2.3.4");
    expect(r.status).toBe(404);
  });

  it("rejects empty names and bodies", async () => {
    expect((await postPageChat(d, "ash-rook", { name: "   ", body: "hi" }, "1.1.1.1")).status).toBe(400);
    expect((await postPageChat(d, "ash-rook", { name: "x", body: "   " }, "1.1.1.1")).status).toBe(400);
  });

  it("burst rate-limits the same IP", async () => {
    const first = await postPageChat(d, "ash-rook", { name: "a", body: "one" }, "9.9.9.9");
    expect(first.status).toBe(201);
    const second = await postPageChat(d, "ash-rook", { name: "a", body: "two" }, "9.9.9.9");
    expect(second.status).toBe(429);
  });

  it("blocks filtered words", async () => {
    // Owner adds a filter word, then a chatter trips it.
    const mod = await moderatePageChat(
      d,
      "ash-rook",
      { action: "filter-add", word: "spamword", auth: "tok-owner" },
      "5.5.5.5",
    );
    expect(mod.status).toBe(200);
    const r = await postPageChat(
      d,
      "ash-rook",
      { name: "t", body: "this has spamword in it" },
      "6.6.6.6",
    );
    expect(r.status).toBe(400);
    // …but the word inside another word does not trip it.
    const ok = await postPageChat(d, "ash-rook", { name: "t", body: "spamwordsmith" }, "6.6.6.7");
    expect(ok.status).toBe(201);
  });
});

describe("listPageChat", () => {
  it("returns messages after `since`", async () => {
    const d = deps();
    await postPageChat(d, "ash-rook", { name: "a", body: "one" }, "1.1.1.1");
    // different IP to dodge the burst limiter
    await postPageChat(d, "ash-rook", { name: "b", body: "two" }, "2.2.2.2");
    const all = await listPageChat(d, "ash-rook", 0);
    expect((all.json as { messages: unknown[] }).messages).toHaveLength(2);
    const firstId = ((all.json as { messages: { id: number }[] }).messages[0]).id;
    const rest = await listPageChat(d, "ash-rook", firstId);
    expect((rest.json as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it("400s on bad room names", async () => {
    const d = deps();
    expect((await listPageChat(d, "../../etc", 0)).status).toBe(400);
  });
});

describe("moderation", () => {
  let d: PageChatDeps;
  beforeEach(() => {
    d = deps();
  });

  async function chatAs(name: string, body: string, ip: string, auth?: string) {
    return postPageChat(d, "ash-rook", { name, body, ...(auth ? { auth } : {}) }, ip);
  }

  it("owner deletes a message", async () => {
    const posted = await chatAs("troll", "bad msg", "7.7.7.7");
    const id = (posted.json as { message: { id: number } }).message.id;
    const del = await moderatePageChat(
      d,
      "ash-rook",
      { action: "delete", messageId: id, auth: "tok-owner" },
      "8.8.8.8",
    );
    expect(del.status).toBe(200);
    const list = await listPageChat(d, "ash-rook", 0);
    expect((list.json as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it("viewers cannot moderate", async () => {
    const posted = await chatAs("troll", "bad msg", "7.7.7.7");
    const id = (posted.json as { message: { id: number } }).message.id;
    const del = await moderatePageChat(
      d,
      "ash-rook",
      { action: "delete", messageId: id, auth: "tok-viewer" },
      "8.8.8.8",
    );
    expect(del.status).toBe(403);
  });

  it("owner mutes by IP — the troll can't post again", async () => {
    const posted = await chatAs("troll", "bad msg", "7.7.7.7");
    const id = (posted.json as { message: { id: number } }).message.id;
    const mute = await moderatePageChat(
      d,
      "ash-rook",
      { action: "mute", messageId: id, auth: "tok-owner" },
      "8.8.8.8",
    );
    expect(mute.status).toBe(200);
    // Same IP, new username → still muted.
    const retry = await chatAs("troll2", "i'm back", "7.7.7.7");
    expect(retry.status).toBe(403);
  });

  it("owner promotes a wallet-verified chatter; the mod can delete", async () => {
    const posted = await chatAs("helper", "i help", "3.3.3.3", "tok-mod");
    const promo = await moderatePageChat(
      d,
      "ash-rook",
      { action: "promote", target: MOD, auth: "tok-owner" },
      "8.8.8.8",
    );
    expect(promo.status).toBe(200);
    expect((promo.json as { mods: string[] }).mods).toContain(MOD);

    const spam = await chatAs("spammer", "junk", "4.4.4.4");
    const spamId = (spam.json as { message: { id: number } }).message.id;
    const del = await moderatePageChat(
      d,
      "ash-rook",
      { action: "delete", messageId: spamId, auth: "tok-mod" },
      "8.8.8.8",
    );
    expect(del.status).toBe(200);
    expect(posted.status).toBe(201); // sanity: the promote target's own message posted fine
  });

  it("promoting needs a wallet address — usernames alone are rejected", async () => {
    const r = await moderatePageChat(
      d,
      "ash-rook",
      { action: "promote", target: "someusername", auth: "tok-owner" },
      "8.8.8.8",
    );
    expect(r.status).toBe(400);
  });

  it("only the owner manages mods", async () => {
    // First make MOD a mod via the owner…
    await moderatePageChat(d, "ash-rook", { action: "promote", target: MOD, auth: "tok-owner" }, "8.8.8.8");
    // …then the mod tries to promote someone else.
    const r = await moderatePageChat(
      d,
      "ash-rook",
      { action: "promote", target: VIEWER, auth: "tok-mod" },
      "8.8.8.8",
    );
    expect(r.status).toBe(403);
  });

  it("owner bans by wallet — verified troll stays out", async () => {
    const posted = await chatAs("troll", "bad", "7.7.7.7", "tok-viewer");
    const id = (posted.json as { message: { id: number } }).message.id;
    const ban = await moderatePageChat(
      d,
      "ash-rook",
      { action: "ban", messageId: id, auth: "tok-owner" },
      "8.8.8.8",
    );
    expect(ban.status).toBe(200);
    // Same wallet, different IP and name → still banned.
    const retry = await postPageChat(
      d,
      "ash-rook",
      { name: "newname", body: "back again", auth: "tok-viewer" },
      "9.9.9.99",
    );
    expect(retry.status).toBe(403);
  });
});

describe("pageChatRole", () => {
  let d: PageChatDeps;
  beforeEach(() => {
    d = deps();
  });

  it("identifies owner, mod, viewer", async () => {
    expect(((await pageChatRole(d, "ash-rook", "tok-owner")).json as { role: string }).role).toBe("owner");
    expect(((await pageChatRole(d, "ash-rook", "tok-viewer")).json as { role: string }).role).toBe("viewer");
    await moderatePageChat(d, "ash-rook", { action: "promote", target: MOD, auth: "tok-owner" }, "1.1.1.1");
    expect(((await pageChatRole(d, "ash-rook", "tok-mod")).json as { role: string }).role).toBe("mod");
  });

  it("401s without a session", async () => {
    expect((await pageChatRole(d, "ash-rook", null)).status).toBe(401);
  });

  it("owner role payload carries the mod panel state", async () => {
    const r = await pageChatRole(d, "ash-rook", "tok-owner");
    const json = r.json as { mods: unknown[]; filters: unknown[]; mutes: unknown[]; bans: unknown[] };
    expect(json.mods).toEqual([]);
    expect(json.filters).toEqual([]);
    expect(json.mutes).toEqual([]);
    expect(json.bans).toEqual([]);
  });
});

describe("defaultPageChatDeps", () => {
  it("wires the shared store and townhall ports", () => {
    const d = defaultPageChatDeps();
    expect(typeof d.store.incr).toBe("function");
    expect(typeof d.registry.resolveOwner).toBe("function");
    expect(typeof d.auth.verifySession).toBe("function");
  });
});
