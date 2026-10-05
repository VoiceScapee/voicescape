/**
 * MCP surface tests — drive real tool calls over InMemoryTransport.
 *
 * Verifies the agent-facing contract: fail-fast validation, error shape,
 * and that the toolset matches what /mcp advertises.
 */
import { describe, expect, it } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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

  it("lists all 25 tools with human-readable titles", async () => {
    const client = await connectedClient();
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(25);
      for (const t of tools) {
        expect(t.title, t.name).toBeTruthy();
        expect(t.description, t.name).toBeTruthy();
      }
      const names = tools.map((t) => t.name);
      expect(names).toContain("render_blockpage");
      expect(names).toContain("render_blockpage_image");
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
    const { READONLY_TOOLS } = await import("@/lib/server/mcp-rate-tiers");
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
