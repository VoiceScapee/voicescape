/**
 * POST /api/agent/chat/build-job route tests: auth gating, action routing,
 * and the start/step handoff to the job module. Step internals are covered
 * in job.test.ts with injected fakes (no network here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "./route";
import { resetAgentChatRateLimit } from "@/lib/agent/rate-limit";
import { issueSessionToken } from "@/lib/server/townhall/auth";
import { signJobStartToken } from "./job";

const SECRET = "test-secret-for-build-job-route";
const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function sessionHeaders(evm: string): Record<string, string> {
  const token = issueSessionToken(
    {
      address: evm,
      chainId: 295,
      nonce: "dd".repeat(16),
      expiresAtMs: Date.now() + 86_400_000,
    },
    Date.now()
  );
  return { "x-vs-session": token };
}

function post(
  body: unknown,
  headers: Record<string, string> = {},
  ip = "9.9.9.2"
) {
  return new NextRequest("http://localhost/api/agent/chat/build-job", {
    method: "POST",
    headers: { "x-forwarded-for": ip, ...headers },
    body: JSON.stringify(body),
  });
}

async function json(res: Response) {
  return (await res.json().catch(() => null)) as Record<string, any> | null;
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("BUDDY_OPERATOR", "1"); // payment gate bypass for start
  resetAgentChatRateLimit();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/agent/chat/build-job", () => {
  it("requires a signed-in wallet", async () => {
    const res = await POST(post({ action: "start", token: "x" }));
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: "signed_in_required" });
  });

  it("rejects an unknown action", async () => {
    const res = await POST(
      post({ action: "dance" }, sessionHeaders(WALLET_A))
    );
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "unknown_action" });
  });

  it("rejects a forged start token", async () => {
    const res = await POST(
      post({ action: "start", token: "bj1.forged" }, sessionHeaders(WALLET_A))
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ error: "bad_token", reason: null });
  });

  it("starts a job for a valid token bound to the session wallet", async () => {
    const token = signJobStartToken({
      wallet: WALLET_A,
      u: "routepage",
      b: "route bio",
      v: "minimal dark",
    });
    const res = await POST(
      post({ action: "start", token }, sessionHeaders(WALLET_A))
    );
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data && typeof data.jobId).toBe("string");
    expect(data && data.step).toBe("copy");
  });

  it("refuses to step another wallet's job", async () => {
    const token = signJobStartToken({
      wallet: WALLET_A,
      u: "routepage2",
      b: "route bio",
      v: "minimal dark",
    });
    const started = await POST(
      post({ action: "start", token }, sessionHeaders(WALLET_A))
    );
    const data = await json(started);
    const jobId = data && data.jobId;
    const res = await POST(
      post({ action: "step", jobId }, sessionHeaders(WALLET_B))
    );
    const out = await json(res);
    expect(out).toEqual({ error: "forbidden", reason: null });
  });

  it("reports job_not_found for an unknown job id", async () => {
    const res = await POST(
      post({ action: "step", jobId: "does-not-exist" }, sessionHeaders(WALLET_A))
    );
    const out = await json(res);
    expect(out).toEqual({ error: "job_not_found", reason: null });
  });
});
