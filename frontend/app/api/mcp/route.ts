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
 * claims, vaults, feedback). The MCP handshake and discovery
 * (initialize, tools/list, ping, notifications) ride the read tier —
 * see lib/server/mcp-rate-limit-tier. Shared fixed-window limiter from
 * lib/server/rate-limit, bucketed separately per tier.
 */

export const runtime = "nodejs";

import {
  MCP_IP_WINDOW_MS,
  rateLimitTierForBody,
  type McpRateLimitTier,
} from "@/lib/server/mcp-rate-limit-tier";
import { DISCOVERABLE_TOOLS } from "@/lib/server/mcp-discoverable-tools";
import { createMcpHandler } from "mcp-handler";
import { checkIpRateLimit, clientIpFromHeaders } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import { recordClientError } from "@/lib/server/client-errors";
import { requestContextStorage } from "@/lib/server/mcp-tools";
import { registerTools, SERVER_INSTRUCTIONS } from "@/lib/server/mcp-tool-registry";

const mcpHandler = createMcpHandler(registerTools, {
  serverInfo: { name: "voicescape", version: "1.1.0" },
  instructions: SERVER_INSTRUCTIONS,
});

/**
 * tools/list discovery filter (2026-11-21): the wire response advertises
 * only DISCOVERABLE_TOOLS. The MCP SDK builds tools/list from every
 * registered tool (71), and the runtime hands each listed schema to the
 * LLM — over 24,000 tokens vs Groq's free-tier 8,000 TPM cap. tools/call is
 * untouched: all 71 tools stay callable by name.
 *
 * The transport answers tools/list as a single SSE `data:` message
 * (stateless server), or plain JSON when the client Accepts only
 * application/json. Either way the payload is filtered by tool name and
 * the rest of the envelope passes through unchanged. Unparseable bodies
 * pass through untouched — a filter failure must never break the protocol.
 */
async function filterToolsListResponse(res: Response): Promise<Response> {
  const text = await res.text().catch(() => null);
  if (text === null) return res;
  const rebuild = (body: string): Response =>
    new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  const filterPayload = (payload: unknown): unknown => {
    if (!payload || typeof payload !== "object") return payload;
    const result = (payload as { result?: unknown }).result;
    if (!result || typeof result !== "object") return payload;
    const tools = (result as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) return payload;
    (result as { tools: unknown[] }).tools = tools.filter(
      (t) =>
        t &&
        typeof t === "object" &&
        typeof (t as { name?: unknown }).name === "string" &&
        DISCOVERABLE_TOOLS.has((t as { name: string }).name),
    );
    return payload;
  };
  try {
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const out = text
        .split("\n")
        .map((line) => {
          if (!line.startsWith("data: ")) return line;
          try {
            return `data: ${JSON.stringify(filterPayload(JSON.parse(line.slice("data: ".length))))}`;
          } catch {
            return line;
          }
        })
        .join("\n");
      return rebuild(out);
    }
    return rebuild(JSON.stringify(filterPayload(JSON.parse(text))));
  } catch {
    return rebuild(text);
  }
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
  // The tier comes from lib/server/mcp-rate-limit-tier: protocol methods
  // (initialize, tools/list, ping, notifications) ride the read tier —
  // only a real write tools/call (or an unparseable body, safe default)
  // burns the write budget.
  let requestId: string | number | null = null;
  let isToolsList = false;
  let tier: McpRateLimitTier = { bucket: "mcp-write", limit: 20, tier: "write" };
  if (req.method === "POST") {
    try {
      const body = await req.clone().json();
      isToolsList = (body as { method?: unknown }).method === "tools/list";
      tier = rateLimitTierForBody(body);
      // Thread the JSON-RPC request id into the tool context so
      // render_blockpage can expose it as the invocation correlation
      // key in widget diagnostics (autonomaavalix's ask, 2026-10-06).
      const rid = (body as { id?: unknown })?.id;
      if (typeof rid === "string" || typeof rid === "number") requestId = rid;
    } catch {
      /* not JSON — safe default below */
    }
  }
  const isReadonly = tier.tier === "read";
  const limit = tier.limit;
  const bucket = tier.bucket;
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

  // The request context (origin, client IP, auth token) travels to the
  // tools via AsyncLocalStorage — the MCP transport does not forward HTTP
  // headers to tool handlers.
  // Authorization: keyless agents whose runtime injects vault-held
  // credentials as a header never see the token value; propose_page_update
  // accepts it as the capability-token source so nothing lands in chat,
  // logs, or tool-call records. The raw value is never logged anywhere.
  const authHeader = req.headers.get("authorization") ?? "";
  const bearerMatch = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  const ctx = {
    origin: new URL(req.url).origin,
    clientIp: clientIpFromHeaders(req.headers),
    requestId,
    authToken: bearerMatch ? bearerMatch[1] : null,
  };
  const res = await requestContextStorage.run(ctx, () => mcpHandler(req));
  // Discovery filter: tools/list advertises only DISCOVERABLE_TOOLS —
  // the full 71-tool list is over 24,000 tokens, 3x Groq's free-tier cap.
  // tools/call is untouched, so every tool stays callable by name.
  if (isToolsList) return filterToolsListResponse(res);
  return res;
}

// Browser-based MCP clients (e.g. a web playground calling the endpoint
// cross-origin) need CORS preflight. Server-side MCP clients are
// unaffected — they never send Origin on POST.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, Authorization, MCP-Protocol-Version",
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
