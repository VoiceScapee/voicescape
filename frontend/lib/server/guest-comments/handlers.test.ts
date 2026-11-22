/**
 * Guest comments handler tests.
 *
 * Model under test: no-login comments that persist; guests cannot post
 * as a registered username (static blocklist + live registry check);
 * the page owner hides comments with a signed session.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createMemoryKvStore, type KvStore } from "../store";
import {
  hideGuestComment,
  listGuestComments,
  postGuestComment,
  type GuestCommentsDeps,
} from "./handlers";

const OWNER = "0x0000000000000000000000000000000000000abc";
const VIEWER = "0x0000000000000000000000000000000000000123";

function deps(): GuestCommentsDeps {
  const store: KvStore = createMemoryKvStore();
  return {
    store,
    registry: {
      resolveOwner: async (u: string) =>
        u === "voicescape-webseries" || u === "some-agent" ? OWNER : null,
    },
    auth: {
      verifySession: async (cred: unknown) => {
        const table: Record<string, string> = {
          "tok-owner": OWNER,
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

describe("postGuestComment", () => {
  let d: GuestCommentsDeps;
  beforeEach(() => {
    d = deps();
  });

  it("lets a guest comment with no wallet", async () => {
    const r = await postGuestComment(d, "voicescape-webseries", "discuss", {
      name: "  CuriousFan ",
      body: "hello, love the show!",
    });
    expect(r.status).toBe(201);
    const list = await listGuestComments(d, "voicescape-webseries", "discuss");
    const comments = (list.json as { comments: { name: string; body: string }[] }).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].name).toBe("CuriousFan");
    expect(comments[0].body).toBe("hello, love the show!");
  });

  it("rejects empty names and bodies, and caps lengths", async () => {
    expect(
      (await postGuestComment(d, "voicescape-webseries", "discuss", { name: "", body: "hi" })).status,
    ).toBe(400);
    expect(
      (await postGuestComment(d, "voicescape-webseries", "discuss", { name: "x", body: "  " })).status,
    ).toBe(400);
    const long = await postGuestComment(d, "voicescape-webseries", "discuss", {
      name: "x".repeat(100),
      body: "y".repeat(1000),
    });
    expect(long.status).toBe(201);
    const list = await listGuestComments(d, "voicescape-webseries", "discuss");
    const c = (list.json as { comments: { name: string; body: string }[] }).comments[0];
    expect(c.name).toHaveLength(24);
    expect(c.body).toHaveLength(500);
  });

  it("rejects reserved names (static list and live registry)", async () => {
    // Static blocklist: the hosts.
    expect(
      (
        await postGuestComment(d, "voicescape-webseries", "discuss", {
          name: "danny",
          body: "impersonating",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await postGuestComment(d, "voicescape-webseries", "discuss", {
          name: "DANNY",
          body: "case-insensitive",
        })
      ).status,
    ).toBe(409);
    // Live registry: a registered name that is NOT on the static list.
    expect(
      (
        await postGuestComment(d, "voicescape-webseries", "discuss", {
          name: "some-agent",
          body: "impersonating",
        })
      ).status,
    ).toBe(409);
  });

  it("404s on unregistered pages", async () => {
    const r = await postGuestComment(d, "nobody-here", "discuss", { name: "x", body: "hi" });
    expect(r.status).toBe(404);
  });

  it("threads replies and rejects unknown parents", async () => {
    const bad = await postGuestComment(d, "voicescape-webseries", "ep1", {
      name: "fan",
      body: "reply to nothing",
      parentId: 99,
    });
    expect(bad.status).toBe(400);
    const top = await postGuestComment(d, "voicescape-webseries", "ep1", {
      name: "fan",
      body: "great episode",
    });
    expect(top.status).toBe(201);
    const topId = (top.json as { id: number }).id;
    const reply = await postGuestComment(d, "voicescape-webseries", "ep1", {
      name: "fan2",
      body: "agreed!",
      parentId: topId,
    });
    expect(reply.status).toBe(201);
    const list = await listGuestComments(d, "voicescape-webseries", "ep1");
    const comments = (list.json as { comments: { parentId: number | null }[] }).comments;
    expect(comments).toHaveLength(2);
    expect(comments[1].parentId).toBe(topId);
  });
});

describe("hideGuestComment", () => {
  let d: GuestCommentsDeps;
  beforeEach(() => {
    d = deps();
  });

  async function seed(): Promise<number> {
    const r = await postGuestComment(d, "voicescape-webseries", "discuss", {
      name: "spammy",
      body: "buy my token",
    });
    return (r.json as { id: number }).id;
  }

  it("requires a session, then owner-only, and hides from the list", async () => {
    const id = await seed();
    expect((await hideGuestComment(d, "voicescape-webseries", "discuss", id, null)).status).toBe(401);
    expect(
      (await hideGuestComment(d, "voicescape-webseries", "discuss", id, "tok-viewer")).status,
    ).toBe(403);
    const ok = await hideGuestComment(d, "voicescape-webseries", "discuss", id, "tok-owner");
    expect(ok.status).toBe(200);
    const list = await listGuestComments(d, "voicescape-webseries", "discuss");
    expect((list.json as { comments: unknown[] }).comments).toHaveLength(0);
    // Hiding twice is a 404 — the comment is already gone.
    expect((await hideGuestComment(d, "voicescape-webseries", "discuss", id, "tok-owner")).status).toBe(404);
  });

  it("reports canModerate only to the page owner", async () => {
    const anon = await listGuestComments(d, "voicescape-webseries", "discuss");
    expect((anon.json as { canModerate: boolean }).canModerate).toBe(false);
    const viewer = await listGuestComments(d, "voicescape-webseries", "discuss", "tok-viewer");
    expect((viewer.json as { canModerate: boolean }).canModerate).toBe(false);
    const owner = await listGuestComments(d, "voicescape-webseries", "discuss", "tok-owner");
    expect((owner.json as { canModerate: boolean }).canModerate).toBe(true);
  });
});
