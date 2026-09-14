/**
 * /api/a2a + /.well-known route tests: JSON-RPC dispatch, SSE stream form,
 * IP gate, and the AgentCard served at both well-known paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getKvStore } from "@/lib/server/store";

import { POST, GET as a2aGET } from "./route";
import { GET as cardGET } from "../../.well-known/agent-card.json/route";
import { GET as legacyCardGET } from "../../.well-known/agent.json/route";
import { clearTaskStore } from "@/lib/a2a/handler";

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/a2a", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sendBody(text: string, method = "SendMessage") {
  return {
    jsonrpc: "2.0",
    id: "r1",
    method,
    params: { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text }] } },
  };
}

beforeEach(async () => {
  await getKvStore().clearPrefix("vs:iprl:");
  clearTaskStore();
  vi.stubEnv("IP_RATE_LIMIT_A2A", "60");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/a2a", () => {
  it("answers SendMessage with a completed task", async () => {
    const res = await POST(post(sendBody("How do I join?")));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.status.state).toBe("TASK_STATE_COMPLETED");
    expect(JSON.stringify(json.result)).toMatch(/registerPage/);
  });

  it("accepts the legacy message/send method", async () => {
    const res = await POST(post(sendBody("hello", "message/send")));
    const json = await res.json();
    expect(json.result.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("returns the A2A method-not-found error for unknown methods", async () => {
    const res = await POST(post({ jsonrpc: "2.0", id: 1, method: "Nope", params: {} }));
    const json = await res.json();
    expect(json.error.code).toBe(-32601);
  });

  it("serves SendStreamingMessage as SSE", async () => {
    const res = await POST(post(sendBody("hi", "SendStreamingMessage")));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toMatch(/TASK_STATE_WORKING/);
    expect(text).toMatch(/TASK_STATE_COMPLETED/);
  });

  it("rate-limits with a 429 after the per-IP budget is spent", async () => {
    vi.stubEnv("IP_RATE_LIMIT_A2A", "1");
    const first = await POST(post(sendBody("hi")));
    expect(first.status).toBe(200);
    const second = await POST(post(sendBody("hi")));
    expect(second.status).toBe(429);
  });
});

describe("GET /api/a2a", () => {
  it("points at the well-known card instead of serving JSON-RPC", async () => {
    const res = await a2aGET();
    expect(res.status).toBe(405);
    expect(JSON.stringify(await res.json())).toMatch(/agent-card/);
  });
});

describe("AgentCard discovery", () => {
  it("serves a spec-shaped card at /.well-known/agent-card.json", async () => {
    const res = await cardGET();
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.name).toBe("danny");
    expect(card.supportedInterfaces[0].protocolBinding).toBe("JSONRPC");
    expect(card.supportedInterfaces[0].url).toMatch(/\/api\/a2a$/);
    expect(card.skills.length).toBeGreaterThan(0);
  });

  it("serves the same card at the legacy /.well-known/agent.json", async () => {
    const res = await legacyCardGET();
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.name).toBe("danny");
  });
});
