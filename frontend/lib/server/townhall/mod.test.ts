/** Moderation hide-filter tests — pure logic, no network. */
import { afterEach, describe, expect, it } from "vitest";
import { filterHiddenPosts, getModWallets, hiddenSeqs, isAuthorizedModAction, isGlobalMod, isModWallet, isOwnerAddress } from "./mod";
import type { ModActionMessage } from "./types";

process.env.TOWNHALL_MODS = "brandon, mod2";

const hide = (
  author: string,
  targetSeq: number,
  board: string | null = null,
  wall: string | null = null,
  targetKind: "post" | "chat" = "post",
): ModActionMessage => ({
  v: 1,
  kind: "mod-action",
  ts: "2026-09-10T00:00:00Z",
  author,
  targetKind,
  board,
  wall,
  targetSeq,
  action: "hide",
});

const post = (seq: number, board: string, wall: string | null = null) => ({
  seq,
  board,
  wall,
  author: "alice",
  body: "hi",
  replyTo: null,
  ts: "2026-09-10T00:00:00Z",
});

describe("isAuthorizedModAction", () => {
  it("authorizes TOWNHALL_MODS members anywhere", () => {
    expect(isAuthorizedModAction(hide("brandon", 1))).toBe(true);
    expect(isAuthorizedModAction(hide("BRANDON", 1))).toBe(true); // case-insensitive
  });

  it("authorizes a wall owner hiding on their own wall", () => {
    expect(isAuthorizedModAction(hide("alice", 1, null, "alice"))).toBe(true);
  });

  it("rejects non-mods hiding on someone else's wall", () => {
    expect(isAuthorizedModAction(hide("mallory", 1, null, "alice"))).toBe(false);
  });

  it("rejects non-mods hiding board posts", () => {
    expect(isAuthorizedModAction(hide("mallory", 1, "general", null))).toBe(false);
  });
});

describe("wallet-based mods (TOWNHALL_MOD_WALLETS)", () => {
  const OLD = process.env.TOWNHALL_MOD_WALLETS;
  const MOD_WALLET = "0x0000000000000000000000000000000000067932"; // 0.0.424242
  afterEach(() => {
    if (OLD === undefined) delete process.env.TOWNHALL_MOD_WALLETS;
    else process.env.TOWNHALL_MOD_WALLETS = OLD;
  });

  it("parses and canonicalizes 0.0.x and hex entries, dropping junk", () => {
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242, 0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD, junk, ,";
    const wallets = getModWallets();
    expect(wallets).toContain(MOD_WALLET);
    expect(wallets).toContain("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    expect(wallets).not.toContain("junk");
    expect(wallets).toHaveLength(2);
  });

  it("isModWallet matches either address form and rejects others", () => {
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242";
    expect(isModWallet("0.0.424242")).toBe(true);
    expect(isModWallet(MOD_WALLET)).toBe(true);
    expect(isModWallet("0x0000000000000000000000000000000000000b001")).toBe(false);
    expect(isModWallet("brandon")).toBe(false);
    expect(isModWallet("")).toBe(false);
  });

  it("isModWallet is false when the env list is empty", () => {
    delete process.env.TOWNHALL_MOD_WALLETS;
    expect(isModWallet(MOD_WALLET)).toBe(false);
  });

  it("the platform owner is a mod wallet in every address form", () => {
    // Regression: canonicalAddress("0.0.10424063") yields the long-zero
    // form, which never equals the wallet's ECDSA-derived EVM address.
    // The owner check must match all forms.
    delete process.env.TOWNHALL_MOD_WALLETS;
    expect(isOwnerAddress("0x30c63dc43608b6764a6b8b53960553aebf306817")).toBe(true);
    expect(isOwnerAddress("0.0.10424063")).toBe(true);
    expect(isOwnerAddress("0x00000000000000000000000000000000009f0eff")).toBe(true);
    expect(isOwnerAddress("0x0000000000000000000000000000000000000b001")).toBe(false);
    expect(isModWallet("0x30c63dc43608b6764a6b8b53960553aebf306817")).toBe(true);
    expect(isModWallet("0.0.10424063")).toBe(true);
    expect(isGlobalMod("user-10424063", null)).toBe(true);
    expect(isGlobalMod("someone", "0x30c63dc43608b6764a6b8b53960553aebf306817")).toBe(true);
  });

  it("isGlobalMod passes for mod usernames and mod wallets", () => {
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242";
    expect(isGlobalMod("brandon", null)).toBe(true); // TOWNHALL_MODS username
    expect(isGlobalMod("alice", "0.0.424242")).toBe(true); // wallet, either form
    expect(isGlobalMod("alice", MOD_WALLET)).toBe(true);
    expect(isGlobalMod("alice", "0x0000000000000000000000000000000000000b001")).toBe(false);
    expect(isGlobalMod("alice")).toBe(false);
  });

  it("authorizes mod-actions authored by a mod wallet address", () => {
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242";
    expect(isAuthorizedModAction(hide(MOD_WALLET, 1))).toBe(true);
  });

  it("authorizes mod-actions carrying modWallet for a username author", () => {
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242";
    const a = hide("alice", 1, "general", null);
    a.modWallet = MOD_WALLET;
    expect(isAuthorizedModAction(a)).toBe(true);
  });

  it("still rejects non-mods, including forged modWallet fields", () => {
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242";
    expect(isAuthorizedModAction(hide("mallory", 1, "general", null))).toBe(false);
    const forged = hide("mallory", 1, "general", null);
    forged.modWallet = "0x0000000000000000000000000000000000000b001";
    expect(isAuthorizedModAction(forged)).toBe(false);
  });

  it("hiddenSeqs honors wallet-mod hides in reads", () => {
    process.env.TOWNHALL_MOD_WALLETS = "0.0.424242";
    const posts = [post(1, "general"), post(2, "general")];
    const out = filterHiddenPosts(posts, [hide(MOD_WALLET, 1)]);
    expect(out.map((p) => p.seq)).toEqual([2]);
  });
});

describe("filterHiddenPosts", () => {
  it("filters a post hidden by a global mod", () => {
    const posts = [post(1, "general"), post(2, "general")];
    const out = filterHiddenPosts(posts, [hide("brandon", 1)]);
    expect(out.map((p) => p.seq)).toEqual([2]);
  });

  it("lets a wall owner hide a post on their own wall", () => {
    const posts = [post(1, "general", "alice"), post(2, "general", "bob")];
    const out = filterHiddenPosts(posts, [hide("alice", 1, null, "alice")]);
    expect(out.map((p) => p.seq)).toEqual([2]);
  });

  it("ignores unauthorized mod-actions", () => {
    const posts = [post(1, "general")];
    const out = filterHiddenPosts(posts, [hide("mallory", 1)]);
    expect(out.map((p) => p.seq)).toEqual([1]);
  });

  it("respects scope: a board-scoped hide does not leak to another board", () => {
    const posts = [post(1, "general"), post(1, "ideas")];
    const out = filterHiddenPosts(posts, [hide("brandon", 1, "general", null)]);
    expect(out).toEqual([post(1, "ideas")]);
  });

  it("a wall-scoped hide does not hide the same seq on a board", () => {
    const posts = [post(1, "general", "alice"), post(1, "general", null)];
    const out = filterHiddenPosts(posts, [hide("alice", 1, null, "alice")]);
    expect(out).toEqual([post(1, "general", null)]);
  });

  it("hiddenSeqs skips non-hide actions", () => {
    const weird = { ...hide("brandon", 1), action: "ban" } as unknown as ModActionMessage;
    expect(hiddenSeqs([weird]).size).toBe(0);
  });

  it("chat-kind hides filter chat messages but not forum posts", () => {
    const chats = [post(1, "lobby"), post(2, "lobby")];
    const out = filterHiddenPosts(chats, [hide("brandon", 1, "lobby", null, "chat")], "chat");
    expect(out.map((p) => p.seq)).toEqual([2]);
  });

  it("post-kind hides do not affect chat filtering", () => {
    const chats = [post(1, "lobby")];
    const out = filterHiddenPosts(chats, [hide("brandon", 1, "lobby", null, "post")], "chat");
    expect(out.map((p) => p.seq)).toEqual([1]);
  });

  it("chat-kind hides do not affect forum filtering", () => {
    const posts = [post(1, "general")];
    const out = filterHiddenPosts(posts, [hide("brandon", 1, "lobby", null, "chat")], "post");
    expect(out.map((p) => p.seq)).toEqual([1]);
  });

  it("legacy mod-actions without targetKind are treated as post hides", () => {
    const { targetKind: _omit, ...legacy } = hide("brandon", 1);
    const posts = [post(1, "general"), post(2, "general")];
    const out = filterHiddenPosts(posts, [legacy as ModActionMessage]);
    expect(out.map((p) => p.seq)).toEqual([2]);
  });
});
