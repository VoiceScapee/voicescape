/**
 * MCP rate-limit tiering — which bucket a JSON-RPC request counts against.
 *
 * Two tiers, per IP, per hour: 100 for reads, 20 for writes. The rule:
 * anything that carries no tool execution and no state change rides the
 * read tier — the MCP handshake, discovery, liveness, notifications, and
 * the resource/prompt reads. Only a tools/call of a non-read-only tool
 * burns the 20/hr write budget. An unparseable body, or a method we do
 * not recognize, keeps the write-tier safe default — never let an unknown
 * request ride the generous tier.
 *
 * Why this exists (Clearance first pass, 2026-11-27): before it, every
 * request that was not a read-only tools/call counted as a write —
 * including `initialize`, `tools/list`, and `ping`. A normal MCP
 * handshake + discovery (~30 calls: initialize, tools/list, then reads)
 * exhausted the 20/hr write budget and 429'd with retry-after ~2920s,
 * even though the documented limit for reads is 100/hr.
 */
import { READONLY_TOOLS } from "./mcp-readonly-tools";

export const MCP_IP_LIMIT_WRITE = 20;
export const MCP_IP_LIMIT_READ = 100;
export const MCP_IP_WINDOW_MS = 3_600_000; // 1 hour

export interface McpRateLimitTier {
  bucket: "mcp-read" | "mcp-write";
  limit: number;
  tier: "read" | "write";
}

/** Client→server JSON-RPC methods that read or negotiate, never mutate. */
const PROTOCOL_READ_METHODS = new Set([
  "initialize",
  "tools/list",
  "ping",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
]);

/**
 * Extract the tool name from a JSON-RPC tools/call request body.
 * Returns null for non-tool calls (initialize, tools/list, etc.) or
 * unparseable bodies.
 */
export function toolNameFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { method?: unknown; params?: unknown };
  if (b.method !== "tools/call") return null;
  const params = b.params as { name?: unknown } | null;
  if (!params || typeof params.name !== "string") return null;
  return params.name;
}

export function rateLimitTierForBody(body: unknown): McpRateLimitTier {
  const method =
    body && typeof body === "object" && typeof (body as { method?: unknown }).method === "string"
      ? (body as { method: string }).method
      : null;
  // Notifications (notifications/*) carry no response and no state change.
  const isProtocolRead =
    (method !== null && PROTOCOL_READ_METHODS.has(method)) ||
    (method !== null && method.startsWith("notifications/"));
  const toolName = toolNameFromBody(body);
  const isReadonly = isProtocolRead || (toolName !== null && READONLY_TOOLS.has(toolName));
  return isReadonly
    ? { bucket: "mcp-read", limit: MCP_IP_LIMIT_READ, tier: "read" }
    : { bucket: "mcp-write", limit: MCP_IP_LIMIT_WRITE, tier: "write" };
}
