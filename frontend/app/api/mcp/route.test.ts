/**
 * MCP surface tests — drive real tool calls over InMemoryTransport.
 *
 * Verifies the agent-facing contract: fail-fast validation, error shape,
 * and that the toolset matches what /mcp advertises.
 */
import { describe, expect, it, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Mock the request context: production threads the JSON-RPC request id
// via AsyncLocalStorage (/api/mcp route), but InMemoryTransport doesn't
// propagate ALS across the transport boundary.
let mockRequestId: string | number | null = null;
vi.mock("@/lib/server/mcp-tools", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/server/mcp-tools")>();
  return {
    ...orig,
    getRequestContext: () => ({
      origin: "https://voicescape.vercel.app",
      clientIp: "test",
      requestId: mockRequestId,
      authToken: null,
    }),
  };
});

import { registerTools } from "@/lib/server/mcp-tool-registry";

async function connectedClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
    _meta?: Record<string, unknown>;
  };
}

describe("MCP tool surface", () => {
  it("rejects an invalid username fast with the format rule", async () => {
    const client = await connectedClient();
    try {
      const res = await callTool(client, "lookup_blockpage", { username: "BAD NAME!" });
      expect(res.isError).toBe(true);
      const text = res.content[0]?.text ?? "";
      expect(text).toMatch(/3-32 lowercase/);
    } finally {
      await client.close();
    }
  });

  it("rejects an invalid username on render_blockpage too", async () => {
    const client = await connectedClient();
    try {
      const res = await callTool(client, "render_blockpage", { username: "no spaces!" });
      expect(res.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("render_blockpage carries _iid on failure (frozen beacon spec)", async () => {
    // autonomaavalix's ask: the invocation id must appear on failed
    // renders too, not just success — support needs the correlation on
    // the cases that generate tickets.
    mockRequestId = "fail-iid-1";
    const client = await connectedClient();
    try {
      const res = await callTool(client, "render_blockpage", {
        username: "no spaces!",
      });
      expect(res.isError).toBe(true);
      const text = res.content[0]?.text ?? "";
      const parsed = JSON.parse(text);
      expect(parsed._iid).toBe("fail-iid-1");
      // No _wid on failure: no widget was issued.
      expect(parsed._wid).toBeUndefined();
    } finally {
      mockRequestId = null;
      await client.close();
    }
  });



  it("prepare_agent_claim('ab') returns machine-readable code/retryable/suggestions", async () => {
    // The stuck-retry loop: an anonymous agent retried username "ab" ~140
    // times across 4 days, ignoring prose. The error must speak machine.
    const client = await connectedClient();
    try {
      const res = await callTool(client, "prepare_agent_claim", { username: "ab", purpose: "test agent" });
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0]?.text ?? "{}");
      expect(body.code).toBe("USERNAME_TOO_SHORT");
      expect(body.retryable).toBe(false);
      expect(body.suggestions).toEqual(["ab-agent", "my-ab-bot"]);
      expect(body.error).toMatch(/too short/);
    } finally {
      await client.close();
    }
  });

  it("lists all 59 tools with human-readable titles", async () => {
    const client = await connectedClient();
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(59);
      for (const t of tools) {
        expect(t.title, t.name).toBeTruthy();
        expect(t.description, t.name).toBeTruthy();
      }
      const names = tools.map((t) => t.name);
      expect(names).toContain("render_blockpage");
      expect(names).toContain("render_blockpage_image");
      expect(names).toContain("prepare_agent_self_claim");
      expect(names).toContain("finalize_agent_self_claim");
      expect(names).toContain("complete_agent_self_claim");
      expect(names).toContain("propose_page_update");
      expect(names).toContain("request_capability_token");
      expect(names).toContain("verify_purchase");
      expect(names).toContain("my_purchases");
      expect(names).toContain("prepare_memecoin_launch");
    } finally {
      await client.close();
    }
  });

  it("prepare_agent_self_claim('ab') returns machine-readable code/retryable/suggestions", async () => {
    const client = await connectedClient();
    try {
      const res = await callTool(client, "prepare_agent_self_claim", {
        username: "ab",
        agent_account_id: "0.0.1234",
        purpose: "test agent",
      });
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0]?.text ?? "{}");
      expect(body.code).toBe("USERNAME_TOO_SHORT");
      expect(body.retryable).toBe(false);
      expect(body.suggestions).toEqual(["ab-agent", "my-ab-bot"]);
      expect(body.error).toMatch(/too short/);
    } finally {
      await client.close();
    }
  });

  it("links render_blockpage to the widget resource via _meta", async () => {
    const client = await connectedClient();
    try {
      const { tools } = await client.listTools();
      const rb = tools.find((t) => t.name === "render_blockpage");
      const meta = rb?._meta as { ui?: { resourceUri?: string } } | undefined;
      expect(meta?.ui?.resourceUri).toBe("ui://voicescape/blockpage-preview");
    } finally {
      await client.close();
    }
  });

  it("declares _meta.ui.csp on the widget resource", async () => {
    const client = await connectedClient();
    try {
      const { resources } = await client.listResources();
      const widget = resources.find((r) => r.uri === "ui://voicescape/blockpage-preview");
      expect(widget?.mimeType).toBe("text/html;profile=mcp-app");
      const meta = widget?._meta as { ui?: { csp?: string } } | undefined;
      expect(meta?.ui?.csp).toContain("default-src 'none'");
      expect(meta?.ui?.csp).toContain("script-src 'unsafe-inline'");
      // The read payload carries the same declaration.
      const read = await client.readResource({ uri: "ui://voicescape/blockpage-preview" });
      const contents = read.contents[0] as { _meta?: { ui?: { csp?: string } }; text?: string };
      expect(contents._meta?.ui?.csp).toBe(meta?.ui?.csp);
      expect(contents.text).toContain("<!DOCTYPE html>");
    } finally {
      await client.close();
    }
  });

  it("keeps the route's READONLY_TOOLS set in parity with registry annotations", async () => {
    // Regression guard (2026-10-04): three read-only tools shipped without
    // being added to the route's tier set and silently throttled at
    // the 20/hour write tier. The tier set must exactly match every tool
    // the registry annotates read-only — no more, no fewer.
    const { READONLY_TOOLS } = await import("@/lib/server/mcp-readonly-tools");
    const client = await connectedClient();
    try {
      const { tools } = await client.listTools();
      const annotatedReadonly = new Set(
        tools
          .filter((t) => (t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true)
          .map((t) => t.name),
      );
      const missing = [...annotatedReadonly].filter((n) => !READONLY_TOOLS.has(n));
      const extra = [...READONLY_TOOLS].filter((n) => !annotatedReadonly.has(n));
      expect(missing, `read-only tools missing from READONLY_TOOLS: ${missing.join(", ")}`).toEqual([]);
      expect(extra, `READONLY_TOOLS entries not annotated read-only: ${extra.join(", ")}`).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe("GET /api/mcp fetch-tool pointer", () => {
  it("answers a non-HTML GET with a machine-readable connect pointer", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      new Request("https://voicescape.vercel.app/api/mcp", {
        headers: { accept: "*/*" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.mcp).toMatch(/not a web page/);
    expect(body.docs).toBe("https://voicescape.vercel.app/mcp");
    expect(body.claude_code).toContain("claude mcp add");
  });

  it("still redirects browser GETs to the docs page", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      new Request("https://voicescape.vercel.app/api/mcp", {
        headers: { accept: "text/html" },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://voicescape.vercel.app/mcp");
  });
});

describe("READONLY_TOOLS drift guard", () => {
  it("matches the registry's READONLY annotations exactly", async () => {
    const { registerTools } = await import("@/lib/server/mcp-tool-registry");
    const { READONLY_TOOLS } = await import("@/lib/server/mcp-readonly-tools");
    const seen: Array<{ name: string; readOnlyHint: boolean }> = [];
    const fakeServer = {
      registerTool: (name: string, config: Record<string, unknown>) => {
        const annotations = (config.annotations ?? {}) as Record<string, unknown>;
        seen.push({ name, readOnlyHint: annotations.readOnlyHint === true });
      },
      registerResource: () => {},
    };
    registerTools(fakeServer as never);
    expect(seen.length).toBeGreaterThan(0);
    const missing = seen
      .filter((t) => t.readOnlyHint && !READONLY_TOOLS.has(t.name))
      .map((t) => t.name);
    expect(missing).toEqual([]);
    const unknown = [...READONLY_TOOLS].filter((n) => !seen.some((t) => t.name === n));
    expect(unknown).toEqual([]);
    const writeInReadonly = seen
      .filter((t) => !t.readOnlyHint && READONLY_TOOLS.has(t.name))
      .map((t) => t.name);
    expect(writeInReadonly).toEqual([]);
  });
});
