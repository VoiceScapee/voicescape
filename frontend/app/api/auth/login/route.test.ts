/**
 * POST /api/auth/login tests — the wallet-signature → session-token
 * endpoint. The crypto itself is covered in
 * lib/server/townhall/auth.test.ts; here we check the endpoint's
 * contract (shapes + status codes).
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/townhall/auth", () => ({
  defaultAuthPort: () => ({
    verifySession: async (cred: unknown) => {
      const sig = (cred as { signature?: unknown } | null)?.signature;
      if (sig === "0xgood") {
        return {
          ok: true,
          session: {
            address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            chainId: 296,
            username: "brandon",
            nonce: "0123456789abcdef0123456789abcdef",
            issuedAtMs: 1_000_000,
            expiresAtMs: 9_999_999_999_999,
          },
        };
      }
      return { ok: false, error: "bad signature" };
    },
  }),
  issueSessionToken: () => "tok.body.sig",
}));

import { POST } from "./route";

function postReq(body: string): NextRequest {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("POST /api/auth/login", () => {
  it("returns 200 + token + session for a verifiable credential", async () => {
    const res = await POST(postReq(JSON.stringify({ credential: { message: "m", signature: "0xgood" } })));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      token: string;
      session: { address: string; chainId: number; expiresAtMs: number };
    };
    expect(json.ok).toBe(true);
    expect(json.token).toBe("tok.body.sig");
    expect(json.session.address).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(json.session.chainId).toBe(296);
  });

  it("also accepts the raw credential shape", async () => {
    const res = await POST(postReq(JSON.stringify({ message: "m", signature: "0xgood" })));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("returns 401 with the verification error for a bad credential", async () => {
    const res = await POST(postReq(JSON.stringify({ credential: { message: "m", signature: "0xbad" } })));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe("bad signature");
  });

  it("returns 400 for a non-credential body", async () => {
    const res = await POST(postReq(JSON.stringify({ hello: "world" })));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await POST(postReq("not json{{{"));
    expect(res.status).toBe(400);
  });
});
