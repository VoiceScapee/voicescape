/**
 * GET/POST/DELETE /api/mcp — Voicescape MCP server (v1).
 *
 * Stateless Streamable HTTP over the official MCP SDK, served from the
 * existing Next.js app (no new infra). One tier: PUBLIC tools any agent
 * on the internet may call (count derived from the registry): read-only mirror-node reads plus
 * write tools (intros, claims, vaults, feedback, messages). No auth,
 * no keys, no signing.
 * The server never holds keys, never signs, never spends.
 *
 * Per-IP rate limit: two tiers — 100/hour for read-only tools
 * (lookup, verify, search, etc.), 20/hour for write tools (intros,
 * claims, vaults, feedback). Shared fixed-window limiter from
 * lib/server/rate-limit, bucketed separately per tier.
 */

export const runtime = "nodejs";

import { createMcpHandler } from "mcp-handler";
import { checkIpRateLimit, clientIpFromHeaders } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import { recordClientError } from "@/lib/server/client-errors";
import { requestContextStorage } from "@/lib/server/mcp-tools";
import { registerTools, SERVER_INSTRUCTIONS } from "@/lib/server/mcp-tool-registry";

const mcpHandler = createMcpHandler(registerTools, {
  serverInfo: { name: "voicescape", version: "1.0.0" },
  instructions: SERVER_INSTRUCTIONS,
});

const MCP_IP_LIMIT_WRITE = 20;
const MCP_IP_LIMIT_READ = 100;
const MCP_IP_WINDOW_MS = 3_600_000; // 1 hour

/**
 * Tools that only read public data — generous limits for legitimate
 * agent exploration. Write tools (intros, claims, vaults, feedback)
 * stay strict — that's where spam/abuse matters.
 */
const READONLY_TOOLS = new Set([
  "lookup_blockpage",
  "verify_tip",
  "treasury_stats",
  "recent_tips",
  "search_agents",
  "check_profile_pin",
  "check_claim_status",
  "list_templates",
  "check_vault_health",
  "check_feedback_status",
  "list_open_bugs",
  "render_blockpage",
  "render_blockpage_image",
  "get_started",
  "quote_tip",
  "trending_creators",
]);

/**
 * Extract the tool name from a JSON-RPC tools/call request body.
 * Returns null for non-tool calls (initialize, tools/list, etc.)
 * or unparseable bodies — those get the stricter write-tier limit
 * as the safe default.
 */
function toolNameFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { method?: unknown; params?: unknown };
  if (b.method !== "tools/call") return null;
  const params = b.params as { name?: unknown } | null;
  if (!params || typeof params.name !== "string") return null;
  return params.name;
}

async function handle(req: Request): Promise<Response> {
  // A browser (or a curious agent) opening the endpoint URL directly gets
  // the human explainer page instead of a JSON-RPC protocol error. MCP
  // clients speak POST with Accept: application/json, text/event-stream —
  // they never send text/html on GET, so this never interferes with them.
  // The redirect runs before the rate limiter so human clicks don't burn
  // the 20/hour MCP budget.
  if (
    req.method === "GET" &&
    (req.headers.get("accept") ?? "").includes("text/html")
  ) {
    return Response.redirect(new URL("/mcp", req.url), 302);
  }

  // A fetch tool or curious agent (Accept: */*, application/json, curl)
  // hitting the endpoint URL directly gets a machine-readable pointer
  // instead of a JSON-RPC "Method not allowed" — the endpoint only runs
  // tools over POST. This runs before the rate limiter so curious fetches
  // don't burn the MCP budget, and it never interferes with real MCP
  // clients, which only ever POST here.
  if (req.method === "GET") {
    const origin = new URL(req.url).origin;
    return Response.json({
      mcp: "This is a Streamable HTTP MCP server endpoint — not a web page.",
      how_to_connect: `Add it to your MCP client as a Streamable HTTP server: ${origin}/api/mcp`,
      claude_code: `claude mcp add --transport http voicescape ${origin}/api/mcp`,
      docs: `${origin}/mcp`,
      note: "This endpoint speaks JSON-RPC over POST. Fetching it with a browser or an assistant's web-fetch tool won't run tools — connect it in an MCP client instead.",
    });
  }

  // Per-IP gate first — cheap, before any MCP protocol work.
  // Two tiers: read-only tools get 100/hour (generous for legitimate
  // agent exploration), write tools stay at 20/hour (abuse prevention).
  // The tool name comes from the JSON-RPC body for tools/call requests.
  let toolName: string | null = null;
  let requestId: string | number | null = null;
  if (req.method === "POST") {
    try {
      const body = await req.clone().json();
      toolName = toolNameFromBody(body);
      // Thread the JSON-RPC request id into the tool context so
      // render_blockpage can expose it as the invocation correlation
      // key in widget diagnostics (autonomaavalix's ask, 2026-10-06).
      const rid = (body as { id?: unknown })?.id;
      if (typeof rid === "string" || typeof rid === "number") requestId = rid;
    } catch {
      /* not JSON — safe default below */
    }
  }
  const isReadonly = toolName !== null && READONLY_TOOLS.has(toolName);
  const limit = isReadonly ? MCP_IP_LIMIT_READ : MCP_IP_LIMIT_WRITE;
  const bucket = isReadonly ? "mcp-read" : "mcp-write";
  let rl;
  try {
    rl = await checkIpRateLimit(
      clientIpFromHeaders(req.headers),
      bucket,
      limit,
      MCP_IP_WINDOW_MS,
    );
  } catch {
    return Response.json(
      { error: "temporarily unavailable — please retry in a moment" },
      { status: 503 },
    );
  }
  if (!rl.allowed) {
    // Throttled agents would otherwise be invisible — record the 429 in
    // the shared error aggregates so a misbehaving client shows up in
    // /api/admin/errors.
    try {
      await recordClientError(getKvStore(), "/api/mcp", "rate-limited", "server", null, Date.now(), {
        action: "rate-limited",
      });
    } catch {
      /* tracking never blocks the response */
    }
    const retryAfterSec = Math.max(1, Math.ceil((rl.retryAfterMs ?? 60_000) / 1000));
    const body = {
      error: `MCP rate limit exceeded: ${limit} requests/hour per IP for ${isReadonly ? "read-only" : "write"} tools`,
      limit: rl.limit,
      retryAfterMs: rl.retryAfterMs,
    };
    // Strict JSON-RPC clients get the envelope they expect on POST;
    // anything else gets the plain error body. Either way, Retry-After
    // tells the client exactly when to come back.
    let payload: unknown = body;
    if (req.method === "POST") {
      try {
        const parsed = (await req.clone().json()) as { id?: unknown };
        if (parsed && "id" in parsed) {
          payload = {
            jsonrpc: "2.0",
            id: parsed.id ?? null,
            error: { code: -32000, message: body.error, data: { limit: rl.limit, retryAfterMs: rl.retryAfterMs } },
          };
        }
      } catch {
        /* not JSON — keep the plain body */
      }
    }
    return Response.json(payload, {
      status: 429,
      headers: { "Retry-After": String(retryAfterSec) },
    });
  }

  // The request context (origin, client IP) travels to the tools via
  // AsyncLocalStorage — the MCP transport does not forward HTTP headers
  // to tool handlers.
  const ctx = {
    origin: new URL(req.url).origin,
    clientIp: clientIpFromHeaders(req.headers),
    requestId,
  };
  return requestContextStorage.run(ctx, () => mcpHandler(req));
}

// Browser-based MCP clients (e.g. a web playground calling the endpoint
// cross-origin) need CORS preflight. Server-side MCP clients are
// unaffected — they never send Origin on POST.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Max-Age": "86400",
};

async function handleWithCors(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const res = await handle(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export const GET = handleWithCors;
export const POST = handleWithCors;
export const DELETE = handleWithCors;
export const OPTIONS = handleWithCors;
