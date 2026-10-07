/**
 * POST /api/social/activity/log tests — the dapp-side producer pipe.
 *
 * The endpoint is the only production writer of the KV sink (logSocialPost
 * previously had zero production callers). Auth is a fail-closed Bearer
 * token (SOCIAL_LOG_TOKEN); the store is the in-memory fallback; rate
 * limiting is mocked open; the gist sink is kept empty/offline.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/rate-limit", () => ({
  ipGate: async () => null,
}));

import { resetKvStoreSingleton } from "@/lib/server/store";
import { readSocialActivity } from "@/lib/server/social-activity";
import { POST } from "./route";
import { GET } from "../route";

const TOKEN = "test-social-log-token";

function postReq(
  body: unknown,
  token: string | null = TOKEN,
): NextRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/social/activity/log", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

let savedToken: string | undefined;

beforeEach(() => {
  resetKvStoreSingleton();
  savedToken = process.env.SOCIAL_LOG_TOKEN;
  process.env.SOCIAL_LOG_TOKEN = TOKEN;
  // The merged reader also checks the gist sink — keep it empty/offline.
  globalThis.fetch = (async () => ({
    ok: true,
    text: async () => "[]",
  })) as unknown as typeof fetch;
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.SOCIAL_LOG_TOKEN;
  else process.env.SOCIAL_LOG_TOKEN = savedToken;
});

describe("POST /api/social/activity/log", () => {
  it("records a valid post with the token and returns 201", async () => {
    const res = await POST(
      postReq({ platform: "x", summary: "morning post" }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });

    const events = await readSocialActivity();
    expect(events).toHaveLength(1);
    expect(events[0].platform).toBe("x");
    expect(events[0].summary).toBe("morning post");
  });

  it("honours a valid client-supplied ts", async () => {
    const ts = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago, within retention
    const res = await POST(
      postReq({ platform: "discord", summary: "ship log", ts }),
    );
    expect(res.status).toBe(201);
    const events = await readSocialActivity();
    expect(events[0].ts).toBe(ts);
  });

  it("rejects a bad token with 401", async () => {
    const res = await POST(
      postReq({ platform: "x", summary: "x" }, "wrong-token"),
    );
    expect(res.status).toBe(401);
    expect(await readSocialActivity()).toHaveLength(0);
  });

  it("rejects a missing token with 401", async () => {
    const res = await POST(
      postReq({ platform: "x", summary: "x" }, null),
    );
    expect(res.status).toBe(401);
  });

  it("fails closed with 401 when SOCIAL_LOG_TOKEN is unset", async () => {
    delete process.env.SOCIAL_LOG_TOKEN;
    const res = await POST(
      postReq({ platform: "x", summary: "x" }),
    );
    expect(res.status).toBe(401);
    expect(await readSocialActivity()).toHaveLength(0);
  });

  it("rejects an invalid platform with 400", async () => {
    const res = await POST(
      postReq({ platform: "telegram", summary: "x" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an oversize summary with 400", async () => {
    const res = await POST(
      postReq({ platform: "x", summary: "s".repeat(301) }),
    );
    expect(res.status).toBe(400);
    expect(await readSocialActivity()).toHaveLength(0);
  });

  it("rejects an empty summary with 400", async () => {
    const res = await POST(postReq({ platform: "x", summary: "" }));
    expect(res.status).toBe(400);
  });

  it("rejects a malformed ts with 400", async () => {
    const res = await POST(
      postReq({ platform: "x", summary: "x", ts: "not-a-date" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a future ts with 400", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await POST(
      postReq({ platform: "x", summary: "x", ts: future }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a ts older than the 7-day retention window with 400", async () => {
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const res = await POST(
      postReq({ platform: "x", summary: "x", ts: old }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-JSON bodies with 400", async () => {
    const req = new NextRequest("http://localhost/api/social/activity/log", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: "this is not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("the public GET feed never exposes summary, even after a POST log", async () => {
    await POST(
      postReq({ platform: "discord", summary: "secret internal note" }),
    );
    const res = await GET(
      new NextRequest("http://localhost/api/social/activity"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    // Content-free contract: platform + ts only — summary must not leak.
    expect(body.events[0]).toEqual({
      platform: "discord",
      ts: expect.any(String),
    });
    expect("summary" in body.events[0]).toBe(false);
    expect(JSON.stringify(body)).not.toContain("secret internal note");
  });
});
