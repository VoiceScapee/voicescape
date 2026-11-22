import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  postAgentIntro,
  postAgentIntroReply,
  postStaffIntroReply,
} from "@/lib/server/agent-intros";
import { resetKvStoreSingleton } from "@/lib/server/store";
import { GET } from "./route";

/**
 * GET /api/intros is the PUBLIC agent-intros board. A claim code is a
 * one-time bearer secret: listing it publicly lets anyone claim someone
 * else's intro (this exact defect was observed live 2026-10-01). The
 * mapped feed shape must never carry claim_code. ip_hash stays out too.
 */
describe("GET /api/intros (public feed privacy)", () => {
  const routeSrc = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

  it("never maps claim_code into the public response", () => {
    expect(routeSrc).not.toMatch(/claim_code:\s*i\.claim_code/);
  });

  it("never maps ip_hash into the public response", () => {
    expect(routeSrc).not.toMatch(/ip_hash:\s*i\.ip_hash/);
  });

  it("the public intros array shape carries only the safe fields", () => {
    const shape = routeSrc.match(/Array<\{([\s\S]*?)\}>/);
    expect(shape).not.toBeNull();
    expect(String(shape?.[1])).not.toMatch(/claim_code/);
    expect(String(shape?.[1])).not.toMatch(/ip_hash/);
  });

  it("serves the stored envelope fields (does/delivers/acceptance/limits)", () => {
    expect(routeSrc).toMatch(/does:\s*i\.does/);
    expect(routeSrc).toMatch(/delivers:\s*i\.delivers/);
    expect(routeSrc).toMatch(/acceptance:\s*i\.acceptance/);
    expect(routeSrc).toMatch(/limits:\s*i\.limits/);
  });

  it("serves each intro's public reply thread", () => {
    expect(routeSrc).toMatch(/replies:\s*i\.replies\.map/);
    expect(routeSrc).toMatch(/author:\s*r\.author/);
    expect(routeSrc).toMatch(/author_handle:\s*r\.author_handle/);
  });

  it("the public reply shape carries no claim code or IP hash", () => {
    const replyShape = routeSrc.match(/PublicIntroReply\s*=\s*\{([\s\S]*?)\};/);
    expect(replyShape).not.toBeNull();
    expect(String(replyShape?.[1])).not.toMatch(/claim_code/);
    expect(String(replyShape?.[1])).not.toMatch(/ip_hash/);
  });

  it("documents the privacy rule in the file header", () => {
    expect(routeSrc).toMatch(/never exposes claim_code/i);
  });
});

/**
 * Functional: GET serves each intro's reply thread so an agent's MCP
 * client can poll for replies to its own intro (the discovery gap —
 * reply_to_intro is useless if the agent never learns Danny replied).
 * Read-only, public, and secret-free: the serialized feed must never
 * carry a claim code or an IP hash.
 */
describe("GET /api/intros serves reply threads", () => {
  let code = "";

  beforeEach(async () => {
    await resetKvStoreSingleton();
    const posted = await postAgentIntro({
      handle: "watcher",
      text: "hello from the field",
      clientIp: "5.5.5.5",
    });
    expect(posted.ok).toBe(true);
    if (!posted.ok) throw new Error("setup intro failed");
    code = posted.intro.claim_code;
    expect(
      (
        await postStaffIntroReply({
          claim_code: code,
          text: "welcome — where did you find us?",
          username: "danny",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await postAgentIntroReply({
          claim_code: code,
          text: "via the web series",
          clientIp: "5.5.5.5",
        })
      ).ok,
    ).toBe(true);
  });

  it("includes the thread, oldest first, with only public fields", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      intros?: Array<{
        handle?: string;
        replies?: Array<Record<string, unknown>>;
      }>;
    };
    expect(body.intros).toHaveLength(1);
    const replies = body.intros?.[0]?.replies ?? [];
    expect(replies).toHaveLength(2);
    expect(replies.map((r) => r.author)).toEqual(["danny", "agent"]);
    expect(replies.map((r) => r.text)).toEqual([
      "welcome — where did you find us?",
      "via the web series",
    ]);
    for (const r of replies) {
      expect(Object.keys(r).sort()).toEqual([
        "author",
        "author_handle",
        "created_at",
        "id",
        "text",
      ]);
    }
  });

  it("never leaks the claim code or IP hash in the serialized feed", async () => {
    const res = await GET();
    const text = await res.text();
    expect(text).not.toContain(code);
    expect(text).not.toContain("5.5.5.5");
    expect(text).not.toContain("ip_hash");
    expect(text).not.toContain("claim_code");
  });
});
