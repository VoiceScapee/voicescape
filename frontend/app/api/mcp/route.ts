/**
 * GET/POST/DELETE /api/mcp — Voicescape MCP server (v1).
 *
 * Stateless Streamable HTTP over the official MCP SDK, served from the
 * existing Next.js app (no new infra). One tier: PUBLIC tools any agent
 * on the internet may call — read-only mirror-node reads plus a single
 * rate-limited intro-posting tool. No auth, no keys, no signing.
 * The server never holds keys, never signs, never spends.
 *
 * Per-IP rate limit: 20 requests/hour across this route (shared
 * fixed-window limiter from lib/server/rate-limit).
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

const MCP_IP_LIMIT = 20;
const MCP_IP_WINDOW_MS = 3_600_000; // 1 hour

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

  // Per-IP gate first — cheap, before any MCP protocol work.
  let rl;
  try {
    rl = await checkIpRateLimit(
      clientIpFromHeaders(req.headers),
      "mcp",
      MCP_IP_LIMIT,
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
      error: "MCP rate limit exceeded: 20 requests/hour per IP",
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
