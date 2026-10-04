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
      expect(text).toMatch(/3-24 lowercase/);
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

  it("lists all 18 tools with human-readable titles", async () => {
    const client = await connectedClient();
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(18);
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
});
