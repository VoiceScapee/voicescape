/**
 * Server-side error telemetry for the MCP route (/api/mcp).
 *
 * Agents calling our tools see failures as toolError results — but nothing
 * was recorded server-side, so there was no way to check what agents (or
 * the flow itself) were hitting. `withMcpErrorTelemetry` wraps every tool
 * handler and records two things into the SAME privacy-scrubbed aggregate
 * store as client errors (recordClientError):
 *
 *   - toolError results  (validation / business-logic failures the tool
 *                         reported back to the agent, e.g. "intro claim
 *                         code not found")
 *   - thrown exceptions   (unexpected failures: mirror node down, bug, …)
 *
 * They surface in /admin/errors (founder-gated) under page "/api/mcp"
 * with component "mcp-<tool-name>" and action "tool-error" /
 * "tool-exception" — so agent-side failures sit right next to the human
 * flow's client errors in one view.
 *
 * Privacy: same rules as client errors — messages are scrubbed of wallet
 * addresses / account IDs / emails / phones, IPs are never stored (the
 * recorder doesn't take one), 7-day TTL, aggregate counts only.
 * Best-effort: recording never throws and never changes what the agent
 * receives — the result (or the original exception) always passes
 * through untouched.
 */
import { getKvStore, type KvStore } from "./store";
import { recordClientError } from "./client-errors";
import type { McpToolResult } from "./mcp-tools";

/** Page slug under which MCP tool errors aggregate in /admin/errors. */
export const MCP_ERROR_PAGE = "/api/mcp";

export interface McpTelemetryDeps {
  /** Override the KV store (tests inject the memory store). */
  store?: KvStore;
}

/**
 * Extract the plain-words message from an MCP error result.
 * toolError() serializes as {"error": "<message>"} with isError: true.
 * Returns null for success results or anything unparseable.
 */
export function mcpToolErrorMessage(res: McpToolResult): string | null {
  if (!res || res.isError !== true) return null;
  const text = res.content?.[0]?.text;
  if (typeof text !== "string" || !text) return null;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    return text;
  } catch {
    return text;
  }
}

/** Sanitized error-class name for the aggregate's `name` field. */
function exceptionName(e: unknown): string | null {
  if (e instanceof Error && typeof e.name === "string" && e.name) {
    const n = e.name.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 40);
    return n || null;
  }
  return null;
}

/** Human-readable message for a thrown value (never throws itself). */
function exceptionMessage(e: unknown): string {
  if (e instanceof Error) {
    const name = exceptionName(e);
    if (e.message) return name ? `${name}: ${e.message}` : e.message;
    return name ? `${name} (no message)` : "Error (no message)";
  }
  if (typeof e === "string") return e || "(empty string thrown)";
  return `thrown ${typeof e}`;
}

async function record(
  store: KvStore,
  toolName: string,
  message: string,
  kind: "tool-error" | "tool-exception",
  name: string | null,
): Promise<void> {
  try {
    await recordClientError(store, MCP_ERROR_PAGE, message, `mcp-${toolName}`, null, Date.now(), {
      name,
      action: kind,
    });
  } catch {
    /* telemetry must never break the MCP response */
  }
}

/**
 * Wrap an MCP tool handler with error telemetry.
 *
 * Records toolError results and thrown exceptions into the founder-gated
 * error store, then passes the original result through (or rethrows the
 * original exception) unchanged — the agent's experience is identical.
 * Never throws from telemetry itself; if the store is unreachable the
 * failure is swallowed and the tool result still goes out.
 */
export async function withMcpErrorTelemetry(
  toolName: string,
  fn: () => Promise<McpToolResult>,
  deps: McpTelemetryDeps = {},
): Promise<McpToolResult> {
  const store = deps.store ?? getKvStore();
  let res: McpToolResult;
  try {
    res = await fn();
  } catch (e) {
    await record(store, toolName, exceptionMessage(e), "tool-exception", exceptionName(e));
    throw e;
  }
  const errMsg = mcpToolErrorMessage(res);
  if (errMsg) {
    await record(store, toolName, errMsg, "tool-error", null);
  }
  return res;
}
