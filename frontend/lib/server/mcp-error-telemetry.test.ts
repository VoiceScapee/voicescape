/**
 * Tests for lib/server/mcp-error-telemetry.ts — server-side MCP tool
 * error telemetry: toolError results and thrown exceptions are recorded
 * into the founder-gated error store, and the original result/exception
 * always passes through to the calling agent unchanged.
 */
import { describe, expect, test } from "vitest";
import { createMemoryKvStore, type KvStore } from "./store";
import { getErrorAggregates } from "./client-errors";
import { toolError, toolResult, type McpToolResult } from "./mcp-tools";
import {
  MCP_ERROR_PAGE,
  mcpToolErrorMessage,
  withMcpErrorTelemetry,
} from "./mcp-error-telemetry";

function mem(): KvStore {
  return createMemoryKvStore();
}

/** A store whose every operation throws — telemetry must stay fail-open. */
function brokenStore(): KvStore {
  const boom = async (): Promise<never> => {
    throw new Error("store down");
  };
  return {
    incr: boom,
    setNx: boom,
    set: boom,
    get: boom,
    del: boom,
    clearPrefix: boom,
  };
}

describe("mcpToolErrorMessage", () => {
  test("null for success results", () => {
    expect(mcpToolErrorMessage(toolResult({ ok: true }))).toBeNull();
  });
  test("extracts the message from a toolError result", () => {
    expect(mcpToolErrorMessage(toolError("intro claim code not found"))).toBe(
      "intro claim code not found",
    );
  });
  test("falls back to raw text when the payload is not JSON", () => {
    const res: McpToolResult = { content: [{ type: "text", text: "plain failure" }], isError: true };
    expect(mcpToolErrorMessage(res)).toBe("plain failure");
  });
  test("null when isError is absent or false", () => {
    const res: McpToolResult = { content: [{ type: "text", text: '{"error":"x"}' }] };
    expect(mcpToolErrorMessage(res)).toBeNull();
  });
});

describe("withMcpErrorTelemetry", () => {
  test("success passes through untouched and records nothing", async () => {
    const store = mem();
    const inner = toolResult({ ok: true, n: 42 });
    const out = await withMcpErrorTelemetry("lookup_blockpage", async () => inner, { store });
    expect(out).toBe(inner);
    expect(await getErrorAggregates(store)).toEqual([]);
  });

  test("toolError result passes through and is recorded", async () => {
    const store = mem();
    const inner = toolError("intro claim code not found — check it and try again");
    const out = await withMcpErrorTelemetry("prepare_agent_vault", async () => inner, { store });
    expect(out).toBe(inner);
    const aggs = await getErrorAggregates(store);
    expect(aggs).toHaveLength(1);
    expect(aggs[0].page).toBe(MCP_ERROR_PAGE);
    expect(aggs[0].page).toBe("/api/mcp");
    expect(aggs[0].component).toBe("mcp-prepare_agent_vault");
    expect(aggs[0].action).toBe("tool-error");
    expect(aggs[0].message).toBe("intro claim code not found — check it and try again");
    expect(aggs[0].count).toBe(1);
  });

  test("thrown Error is rethrown unchanged and recorded as tool-exception", async () => {
    const store = mem();
    const boom = new TypeError("mirror node exploded");
    await expect(
      withMcpErrorTelemetry("treasury_stats", async () => {
        throw boom;
      }, { store }),
    ).rejects.toBe(boom);
    const aggs = await getErrorAggregates(store);
    expect(aggs).toHaveLength(1);
    expect(aggs[0].component).toBe("mcp-treasury_stats");
    expect(aggs[0].action).toBe("tool-exception");
    expect(aggs[0].name).toBe("TypeError");
    expect(aggs[0].message).toContain("mirror node exploded");
  });

  test("thrown non-Error values are recorded and rethrown", async () => {
    const store = mem();
    await expect(
      withMcpErrorTelemetry("verify_tip", async () => {
        // eslint-disable-next-line no-throw-literal
        throw "string blowup";
      }, { store }),
    ).rejects.toBe("string blowup");
    const aggs = await getErrorAggregates(store);
    expect(aggs).toHaveLength(1);
    expect(aggs[0].action).toBe("tool-exception");
    expect(aggs[0].message).toBe("string blowup");
  });

  test("identifiers in messages are scrubbed before storage", async () => {
    const store = mem();
    await withMcpErrorTelemetry(
      "prepare_vault_page",
      async () => toolError("vault 0.0.987654 rejected key 0xabcdef1234567890"),
      { store },
    );
    const aggs = await getErrorAggregates(store);
    expect(aggs).toHaveLength(1);
    expect(aggs[0].message).toContain("0.0.…");
    expect(aggs[0].message).toContain("0x…");
    expect(aggs[0].message).not.toContain("0.0.987654");
    expect(aggs[0].message).not.toContain("0xabcdef1234567890");
  });

  test("repeated failures aggregate into one bucket with a count", async () => {
    const store = mem();
    for (let i = 0; i < 3; i++) {
      await withMcpErrorTelemetry("post_agent_intro", async () => toolError("handle taken"), { store });
    }
    const aggs = await getErrorAggregates(store);
    expect(aggs).toHaveLength(1);
    expect(aggs[0].count).toBe(3);
    expect(aggs[0].component).toBe("mcp-post_agent_intro");
  });

  test("telemetry failure never breaks the tool result (fail-open)", async () => {
    const store = brokenStore();
    const inner = toolError("something failed");
    const out = await withMcpErrorTelemetry("prepare_agent_claim", async () => inner, { store });
    expect(out).toBe(inner);
  });

  test("telemetry failure never swallows a thrown exception (fail-open)", async () => {
    const store = brokenStore();
    const boom = new Error("real failure");
    await expect(
      withMcpErrorTelemetry("check_vault_health", async () => {
        throw boom;
      }, { store }),
    ).rejects.toBe(boom);
  });
});
