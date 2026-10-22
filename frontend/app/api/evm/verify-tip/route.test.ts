/**
 * Tests for POST /api/evm/verify-tip — the EVM tip confirmation proof.
 * The mirror node is mocked via global fetch; no live network is called.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { TIPSENT_TOPIC } from "@/lib/leaderboard";
import { POST } from "./route";

function padTopic(address: string): string {
  return "0x" + "0".repeat(24) + address.slice(2).toLowerCase();
}

function word(value: bigint): string {
  return "0x" + value.toString(16).padStart(64, "0");
}

const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";

function tipLog() {
  return {
    contract_id: "0.0.10854060",
    topics: [TIPSENT_TOPIC, padTopic(FROM), padTopic(FROM), padTopic(TO)],
    data: word(10_000_000n) + word(200_000n).slice(2),
    timestamp: "1791392670.082124104",
    index: 0,
  };
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/evm/verify-tip", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function mockMirror(logs: unknown[], ok = true) {
  vi.stubGlobal(
    "fetch",
    async () => ({ ok, json: async () => ({ logs }) }) as Response,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/evm/verify-tip", () => {
  it("verifies a matching TipSent and returns exact tinybar words", async () => {
    mockMirror([tipLog()]);
    const res = await POST(post({ from: FROM, to: TO, grossTinybar: "10000000" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.verified).toBe(true);
    expect(json.matched.grossTinybar).toBe("10000000");
    expect(json.matched.feeTinybar).toBe("200000");
  });

  it("reports unverified when no log matches", async () => {
    mockMirror([tipLog()]);
    const res = await POST(post({ from: FROM, to: TO, grossTinybar: "999" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.verified).toBe(false);
    expect(json.reason).toBe("no-matching-log");
  });

  it("reports mirror problems as unverified, not a 500, so the UI keeps polling", async () => {
    mockMirror([], false);
    const res = await POST(post({ from: FROM, to: TO, grossTinybar: "10000000" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.verified).toBe(false);
    expect(json.reason).toBe("mirror-unreachable");
  });

  it("rejects malformed bodies with 400", async () => {
    mockMirror([tipLog()]);
    const badAddress = await POST(post({ from: "nope", to: TO, grossTinybar: "10000000" }));
    expect(badAddress.status).toBe(400);
    const badGross = await POST(post({ from: FROM, to: TO, grossTinybar: "1.5" }));
    expect(badGross.status).toBe(400);
    const badJson = await POST(post("{not json"));
    expect(badJson.status).toBe(400);
  });
});
