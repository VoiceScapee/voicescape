/**
 * POST /api/intros/replies auth tests: staff replies are a write, and
 * only the danny session may post them. The route must 401 with no
 * session and 403 for any other wallet/agent before touching the body.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SESSION_HEADER } from "@/lib/session-message";
import { postAgentIntro } from "@/lib/server/agent-intros";
import { resetKvStoreSingleton } from "@/lib/server/store";

vi.mock("@/lib/server/townhall/auth", () => ({
  defaultAuthPort: () => ({
    verifySession: async (cred: unknown) => {
      if (cred === GOOD_TOKEN) {
        return {
          ok: true,
          session: {
            address: "0x4fb76eaa5eb6152501e99ca385c21d3dedf4ccca",
            agent: { username: "danny" },
          },
        };
      }
      if (cred === OTHER_TOKEN) {
        return {
          ok: true,
          session: {
            address: "0x0000000000000000000000000000000000000001",
            agent: { username: "forge" },
          },
        };
      }
      return { ok: false, error: "missing session: sign in with your wallet" };
    },
  }),
}));

const GOOD_TOKEN = "danny-session-token";
const OTHER_TOKEN = "forge-session-token";

import { POST } from "./route";

function req(token: string | null, json: unknown): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers[SESSION_HEADER] = token;
  return new NextRequest("http://localhost/api/intros/replies", {
    method: "POST",
    headers,
    body: JSON.stringify(json),
  });
}

describe("POST /api/intros/replies auth", () => {
  let code = "";

  beforeEach(async () => {
    await resetKvStoreSingleton();
    const posted = await postAgentIntro({
      handle: "newcomer",
      text: "hello from the field",
      clientIp: "5.5.5.5",
    });
    expect(posted.ok).toBe(true);
    if (!posted.ok) throw new Error("setup intro failed");
    code = posted.intro.claim_code;
  });

  it("returns 401 with no session header", async () => {
    const res = await POST(req(null, { claim_code: code, text: "hi" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 for a signed-in agent that is not danny", async () => {
    const res = await POST(req(OTHER_TOKEN, { claim_code: code, text: "hi" }));
    expect(res.status).toBe(403);
  });

  it("lets danny post a staff reply", async () => {
    const res = await POST(
      req(GOOD_TOKEN, { claim_code: code, text: "welcome — where did you find us?" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; reply?: { author?: string; text?: string } };
    expect(body.ok).toBe(true);
    expect(body.reply?.author).toBe("danny");
    expect(body.reply?.text).toBe("welcome — where did you find us?");
  });

  it("returns 400 for an unknown claim code", async () => {
    const res = await POST(req(GOOD_TOKEN, { claim_code: "ZZZZ-YYYY", text: "hi" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty text", async () => {
    const res = await POST(req(GOOD_TOKEN, { claim_code: code, text: "   " }));
    expect(res.status).toBe(400);
  });
});
