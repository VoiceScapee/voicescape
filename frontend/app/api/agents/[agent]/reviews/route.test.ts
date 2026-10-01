/**
 * /api/agents/[agent]/reviews route tests: auth gate + public GET.
 *
 * Auth is exercised for real (401 without/invalid session). The full
 * proof-of-payment POST path is covered in lib/server/agents/reviews.test.ts
 * with an injected mirror-node fetch; here we only assert the route's
 * guardrails, which need no network.
 */
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { GET, POST } from "./route";

type Params = { params: Promise<{ agent: string }> };
const paramsFor = (agent: string): Params => ({ params: Promise.resolve({ agent }) });

function postReq(agent: string, body: unknown, session?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) headers["x-vs-session"] = session;
  return new NextRequest(`http://localhost/api/agents/${agent}/reviews`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function getReq(agent: string, query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/agents/${agent}/reviews${query}`, {
    method: "GET",
  });
}

const BODY = { txId: "0.0.7@1700000000.000000001", rating: 5, text: "great work" };

describe("POST /api/agents/[agent]/reviews", () => {
  it("401s without a session", async () => {
    const res = await POST(postReq("forge", BODY), paramsFor("forge"));
    expect(res.status).toBe(401);
  });

  it("401s with a garbage session", async () => {
    const res = await POST(postReq("forge", BODY, "not-a-session"), paramsFor("forge"));
    expect(res.status).toBe(401);
  });

  it("400s on an invalid agent username before auth", async () => {
    const res = await POST(postReq("BAD!!", BODY), paramsFor("BAD!!"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/agents/[agent]/reviews", () => {
  it("400s on an invalid agent username", async () => {
    const res = await GET(getReq("BAD!!"), paramsFor("BAD!!"));
    expect(res.status).toBe(400);
  });

  it("returns an empty list for an agent with no reviews", async () => {
    const res = await GET(getReq("someagent"), paramsFor("someagent"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reviews: [], count: 0, avg: null });
  });
});
