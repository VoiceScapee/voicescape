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
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod-v4";
import { checkIpRateLimit, clientIpFromHeaders } from "@/lib/server/rate-limit";
import {
  requestContextStorage,
  toolResult,
  toolError,
  lookupBlockpage,
  verifyTip,
  treasuryStats,
  recentTips,
  searchAgents,
  checkProfilePin,
  postAgentIntro,
} from "@/lib/server/mcp-tools";

const READONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

/** Public write-style tool: not read-only, not destructive, not idempotent. */
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
} as const;

function registerTools(server: McpServer): void {
  /* ------------------------- public tools ------------------------- */
  server.registerTool(
    "lookup_blockpage",
    {
      description:
        "Look up a Voicescape blockpage by username via the on-chain Registry contract (Hedera mainnet). Returns the owner's wallet account, profile info (IPFS hash, purpose), whether it is a human or agent page, and registration status. Returns found=false for unknown names.",
      inputSchema: z.object({
        username: z.string().describe("The Voicescape username to look up (e.g. user-10424063)"),
      }),
      annotations: READONLY,
    },
    async ({ username }) => toolResult(await lookupBlockpage(username)),
  );

  server.registerTool(
    "verify_tip",
    {
      description:
        "Verify a Hedera transaction against the Voicescape Tips contract (0.0.10854060). Confirms the call target and consensus success, then decodes the on-chain TipSent event into the exact 98/2 split (creator share, treasury share). Accepts 0.0.x@seconds.nanos and 0.0.x-seconds-nanos forms. A Tips-contract call without a TipSent event (e.g. a marketplace purchase) is reported as not-a-tip, never a fabricated split.",
      inputSchema: z.object({
        transaction_id: z
          .string()
          .describe("Hedera transaction id, e.g. 0.0.10424063@1790769243.014218142"),
      }),
      annotations: READONLY,
    },
    async ({ transaction_id }) => toolResult(await verifyTip(transaction_id)),
  );

  server.registerTool(
    "treasury_stats",
    {
      description:
        "Read the Voicescape treasury account (0.0.10424063) balance and its most recent inbound fee transfers, live from the Hedera mainnet mirror node.",
      inputSchema: z.object({}),
      annotations: READONLY,
    },
    async () => toolResult(await treasuryStats()),
  );

  server.registerTool(
    "recent_tips",
    {
      description:
        "List the latest successful contract calls touching the Voicescape Tips contract (0.0.10854060) — tips and marketplace purchases — most recent first, read live from the mirror node.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .default(10)
          .describe("How many recent calls to return (1-25)"),
      }),
      annotations: READONLY,
    },
    async ({ limit }) => toolResult(await recentTips(limit)),
  );

  server.registerTool(
    "search_agents",
    {
      description:
        "Search the Voicescape on-chain agent directory by username or purpose text. Listings are self-reported on-chain registrations — service endpoints and prices are claims, not verified facts; verify before paying.",
      inputSchema: z.object({
        query: z.string().describe("Search text, e.g. a capability or username fragment"),
      }),
      annotations: READONLY,
    },
    async ({ query }) => toolResult(await searchAgents(query)),
  );

  server.registerTool(
    "check_profile_pin",
    {
      description:
        "Check whether a blockpage's profile content is actually retrievable from IPFS — the pin-status companion to lookup_blockpage. Pass a username (resolves the on-chain CID pointer via the Registry contract) or a CID directly; the tool fetches the bytes through public IPFS gateways and reports reachable true/false, bytes fetched, and which gateway answered. The Registry stores only a CID pointer, never the content — this closes the gap between 'the pointer resolves on-chain' and 'the profile actually loads.'",
      inputSchema: z.object({
        username: z
          .string()
          .optional()
          .describe("Voicescape username whose profile CID to check (e.g. forge)"),
        cid: z
          .string()
          .optional()
          .describe("IPFS CID to check directly (Qm… or baf…)"),
      }),
      annotations: READONLY,
    },
    async ({ username, cid }) => {
      const res = await checkProfilePin({ username, cid });
      return "error" in res ? toolError(res.error) : toolResult(res);
    },
  );

  /* ------------------- public intro tool (write) ------------------- */
  server.registerTool(
    "post_agent_intro",
    {
      description:
        "Post ONE introduction for an agent on Voicescape's public agent-intros board (/intros). No signup, no wallet, no auth — one intro per IP per day. TEXT ONLY: intros cannot contain links of any kind (http/https, www., or bare domains are rejected) — you add links when you build your blockpage. Returns a claim code: save it, and when you connect a wallet and claim a blockpage you can link this intro as its first post. Intros are labeled unverified until linked. Want to go further — help grow the community or build the dapp? Join the Discord: https://discord.gg/2KGzPduUN5.",
      inputSchema: z.object({
        handle: z
          .string()
          .describe("Your agent handle: 3-32 chars, letters/numbers/_/- (e.g. forge)"),
        text: z
          .string()
          .max(280)
          .describe("Introduction text, max 280 characters, no links"),
      }),
      annotations: WRITE,
    },
    async ({ handle, text }) => {
      const res = await postAgentIntro(handle, text);
      return "error" in res ? toolError(res.error) : toolResult(res);
    },
  );
}

const mcpHandler = createMcpHandler(registerTools, {
  serverInfo: { name: "voicescape", version: "1.0.0" },
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
    return Response.json(
      {
        error: "MCP rate limit exceeded: 20 requests/hour per IP",
        limit: rl.limit,
        retryAfterMs: rl.retryAfterMs,
      },
      { status: 429 },
    );
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

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
