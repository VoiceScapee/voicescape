/** MCP rate-limit tiering — Clearance first pass, 2026-11-27. */
import { describe, expect, it } from "vitest";
import { rateLimitTierForBody, toolNameFromBody } from "./mcp-rate-limit-tier";

function callBody(tool: string) {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: {} } };
}

describe("rateLimitTierForBody", () => {
  it("counts protocol methods in the read tier", () => {
    for (const method of [
      "initialize",
      "tools/list",
      "ping",
      "notifications/initialized",
      "notifications/cancelled",
      "resources/list",
      "resources/read",
      "prompts/list",
      "prompts/get",
    ]) {
      const t = rateLimitTierForBody({ jsonrpc: "2.0", id: 1, method });
      expect(t.bucket, method).toBe("mcp-read");
      expect(t.limit, method).toBe(100);
      expect(t.tier, method).toBe("read");
    }
  });

  it("counts read-only tools/call in the read tier", () => {
    const t = rateLimitTierForBody(callBody("lookup_blockpage"));
    expect(t).toEqual({ bucket: "mcp-read", limit: 100, tier: "read" });
    expect(rateLimitTierForBody(callBody("verify_tip")).tier).toBe("read");
    expect(rateLimitTierForBody(callBody("review_agent_tipping")).tier).toBe("read");
  });

  it("counts write tools/call in the write tier", () => {
    const t = rateLimitTierForBody(callBody("post_agent_intro"));
    expect(t).toEqual({ bucket: "mcp-write", limit: 20, tier: "write" });
    expect(rateLimitTierForBody(callBody("prepare_agent_claim")).tier).toBe("write");
  });

  it("keeps the write-tier safe default for unparseable bodies and unknown methods", () => {
    expect(rateLimitTierForBody(null).tier).toBe("write");
    expect(rateLimitTierForBody("not json").tier).toBe("write");
    expect(rateLimitTierForBody({}).tier).toBe("write");
    expect(rateLimitTierForBody({ method: "tools/call", params: {} }).tier).toBe("write");
    expect(rateLimitTierForBody({ method: "sampling/createMessage" }).tier).toBe("write");
    expect(rateLimitTierForBody({ method: "roots/list" }).tier).toBe("write");
  });

  it("toolNameFromBody extracts only tools/call names", () => {
    expect(toolNameFromBody(callBody("lookup_blockpage"))).toBe("lookup_blockpage");
    expect(toolNameFromBody({ method: "initialize" })).toBeNull();
    expect(toolNameFromBody(null)).toBeNull();
  });
});
