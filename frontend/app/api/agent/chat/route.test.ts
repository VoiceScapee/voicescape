/**
 * POST /api/agent/chat route tests: fail-closed without a key, per-IP rate
 * limiting, and the Groq tool-calling round trip with a mocked fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AbiCoder } from "ethers";

import { POST } from "./route";
import { resetAgentChatRateLimit } from "@/lib/agent/rate-limit";
import { resetKvStoreSingleton } from "@/lib/server/store";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Forge fixture: 0.0.10862061, AGENT
const FORGE_EVM = "0x5274e1499d145d6f4984661203bf65c2bed7f8ce";
const FORGE_ACCOUNT = `0.0.${BigInt(FORGE_EVM).toString()}`;
const OPERATOR_EVM = "0x0000000000000000000000000000000000000001";

function groqFinal(reply: string) {
  return {
    choices: [
      {
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
      },
    ],
  };
}

function groqToolCall(name: string, args: object, id = "call_1") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function resolvePageResult(): string {
  return AbiCoder.defaultAbiCoder().encode(
    ["address", "string", "uint8", "address", "string"],
    [FORGE_EVM, "QmTestHash", 1, OPERATOR_EVM, "test purpose"]
  );
}

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as any;
}

/** Install a fetch mock; groqReplies are served in order to the Groq endpoint. */
function mockFetch(groqReplies: unknown[]) {
  const groqBodies: any[] = [];
  const seen: string[] = [];
  const calls = { groqBodies, seen };
  const impl = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    seen.push(u);
    if (u.startsWith(GROQ_URL)) {
      groqBodies.push(JSON.parse(String(init?.body ?? "{}")));
      const next = groqReplies.shift();
      if (!next) throw new Error("unexpected extra Groq call");
      return jsonResponse(next);
    }
    if (u.includes("/contracts/call")) {
      return jsonResponse({ result: resolvePageResult() });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", impl);
  return { impl, calls };
}

function post(body: unknown, ip = "1.2.3.4"): NextRequest {
  return new NextRequest("http://localhost/api/agent/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetAgentChatRateLimit();
  // Fresh metering store per test: the shared KvStore singleton would
  // otherwise carry the anon session's free-tier usage across tests.
  resetKvStoreSingleton();
  vi.stubEnv("GROQ_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/agent/chat", () => {
  it("fails closed with 503 when GROQ_API_KEY is missing", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    mockFetch([]);
    const res = await POST(post({ message: "hi" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "chat_unavailable" });
  });

  it("rejects empty messages with 400", async () => {
    mockFetch([]);
    const res = await POST(post({ message: "   " }));
    expect(res.status).toBe(400);
  });

  it("rate-limits an IP after 20 messages per hour", async () => {
    // Every request gets a plain final answer from the mocked Groq.
    mockFetch(Array.from({ length: 20 }, () => groqFinal("ok")));
    for (let i = 0; i < 20; i++) {
      const res = await POST(post({ message: `q${i}` }));
      expect(res.status).toBe(200);
    }
    // 21st needs no Groq reply — it must be rejected before any fetch.
    const limited = await POST(post({ message: "one too many" }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });

  it("does not rate-limit a different IP", async () => {
    mockFetch([groqFinal("ok"), groqFinal("ok")]);
    const a = await POST(post({ message: "hi" }, "9.9.9.9"));
    const b = await POST(post({ message: "hi" }, "8.8.8.8"));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it("answers a plain question without tool calls", async () => {
    const { calls } = mockFetch([groqFinal("Voicescape is a blockpage platform.")]);
    const res = await POST(post({ message: "What is Voicescape?" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.reply).toMatch(/blockpage platform/);
    // Only one Groq call, no mirror-node traffic.
    expect(calls.groqBodies).toHaveLength(1);
    expect(calls.seen.every((u) => !u.includes("mirrornode"))).toBe(true);
  });

  it("runs the resolve_blockpage tool round trip and returns the final answer", async () => {
    const { calls } = mockFetch([
      groqToolCall("resolve_blockpage", { username: "forge" }),
      groqFinal("Yes! forge is registered to an agent account."),
    ]);
    const res = await POST(post({ message: "Is forge registered?" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.reply).toMatch(/registered to an agent/);

    // Two Groq calls: tool request, then final answer with tool results.
    expect(calls.groqBodies).toHaveLength(2);
    const second = calls.groqBodies[1];
    const toolMsg = second.messages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    const toolResult = JSON.parse(toolMsg.content);
    expect(toolResult.registered).toBe(true);
    expect(toolResult.ownerAccountId).toBe(FORGE_ACCOUNT);
    expect(toolResult.ownerType).toBe("AGENT");
    expect(toolResult.purpose).toBe("test purpose");

    // The model saw the system prompt on both calls.
    for (const body of calls.groqBodies) {
      expect(body.model).toBe("openai/gpt-oss-20b");
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[0].content).toMatch(/never invent chain data/);
      expect(body.tools.map((t: any) => t.function.name)).toEqual([
        "resolve_blockpage",
        "verify_tip",
        "treasury_stats",
      ]);
    }
  });

  it("caps history at 6 items", async () => {
    const { calls } = mockFetch([groqFinal("ok")]);
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `h${i}`,
    }));
    await POST(post({ message: "latest", history }));
    const sent = calls.groqBodies[0].messages;
    // system + 6 history + current message
    expect(sent).toHaveLength(8);
    expect(sent[1].content).toBe("h4");
    expect(sent[7]).toEqual({ role: "user", content: "latest" });
  });
});
