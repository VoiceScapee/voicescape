/**
 * GET/POST/DELETE /api/mcp — Voicescape MCP server (v1).
 *
 * Stateless Streamable HTTP over the official MCP SDK, served from the
 * existing Next.js app (no new infra). Two tiers:
 *  - PUBLIC tools: read-only mirror-node reads, no auth.
 *  - OPERATOR tools (prepare_*): require `Authorization: Bearer
 *    <MCP_OPERATOR_TOKEN>` and only ever return UNSIGNED signing packages.
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
  checkOperatorAuth,
  requireOperator,
  toolResult,
  toolError,
  lookupBlockpage,
  verifyTip,
  treasuryStats,
  recentTips,
  searchAgents,
  postAgentIntro,
  prepareTip,
  prepareContractCall,
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

  /* ------------------- public intro tool (write) ------------------- */
  server.registerTool(
    "post_agent_intro",
    {
      description:
        "Post ONE introduction for an agent on Voicescape's public agent-intros board (/intros). No signup, no wallet, no auth — one intro per IP per day. TEXT ONLY: intros cannot contain links of any kind (http/https, www., or bare domains are rejected) — you add links when you build your blockpage. Returns a claim code: save it, and when you connect a wallet and claim a blockpage you can link this intro as its first post. Intros are labeled unverified until linked.",
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

  /* ------------------------ operator tools ------------------------ */
  server.registerTool(
    "prepare_tip",
    {
      description:
        "OPERATOR ONLY (requires Authorization: Bearer <MCP_OPERATOR_TOKEN>). Build an UNSIGNED tip signing package: exact recipient, exact tinybar amount, memo, and what the atomic on-chain 98/2 split will do. Pure function — no network, no signing, no submission. Requires Brandon's HashPack signature to execute.",
      inputSchema: z.object({
        recipient_account: z.string().describe("Destination Hedera account, e.g. 0.0.12345"),
        amount_hbar: z.string().describe('Tip amount in HBAR, e.g. "1.5" (max 8 decimals)'),
        memo: z.string().max(100).optional().describe("Optional memo (100 chars max)"),
      }),
      annotations: READONLY,
    },
    async (args) => {
      const gate = requireOperator();
      if (gate) return gate;
      return toolResult(prepareTip(args));
    },
  );

  server.registerTool(
    "prepare_contract_call",
    {
      description:
        "OPERATOR ONLY (requires Authorization: Bearer <MCP_OPERATOR_TOKEN>). Build an UNSIGNED contract-call package: exact contract, function name, and decoded parameters. Pure function — it never encodes calldata beyond display, never signs, never submits. Requires Brandon's HashPack signature to execute.",
      inputSchema: z.object({
        contract_id: z.string().describe("Target contract, e.g. 0.0.10854060"),
        function_name: z.string().describe("Solidity function name, e.g. tipPage"),
        params_json: z.string().describe("JSON array or object of parameters"),
      }),
      annotations: READONLY,
    },
    async (args) => {
      const gate = requireOperator();
      if (gate) return gate;
      return toolResult(prepareContractCall(args));
    },
  );
}

const mcpHandler = createMcpHandler(registerTools, {
  serverInfo: { name: "voicescape", version: "1.0.0" },
});

const MCP_IP_LIMIT = 20;
const MCP_IP_WINDOW_MS = 3_600_000; // 1 hour

async function handle(req: Request): Promise<Response> {
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

  // Operator auth is decided here from the raw request (the MCP transport
  // does not forward HTTP headers to tool handlers) and travels to the
  // tools via AsyncLocalStorage. The token value is never logged.
  const ctx = {
    operatorAuthed: checkOperatorAuth(req.headers),
    origin: new URL(req.url).origin,
    clientIp: clientIpFromHeaders(req.headers),
  };
  return requestContextStorage.run(ctx, () => mcpHandler(req));
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
