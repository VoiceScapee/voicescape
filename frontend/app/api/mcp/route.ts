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
import { getKvStore } from "@/lib/server/store";
import { recordClientError } from "@/lib/server/client-errors";
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
  prepareAgentClaim,
  listTemplates,
} from "@/lib/server/mcp-tools";
import { stashPendingAction, PendingActionConflictError } from "@/lib/server/pending-actions";
import { prepareAgentVault, checkVaultHealthTool, prepareVaultPage } from "@/lib/server/vault-mcp";
import { withMcpErrorTelemetry } from "@/lib/server/mcp-error-telemetry";

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
    async ({ username }) =>
      withMcpErrorTelemetry("lookup_blockpage", async () => toolResult(await lookupBlockpage(username))),
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
    async ({ transaction_id }) =>
      withMcpErrorTelemetry("verify_tip", async () => toolResult(await verifyTip(transaction_id))),
  );

  server.registerTool(
    "treasury_stats",
    {
      description:
        "Read the Voicescape treasury account (0.0.10424063) balance and its most recent inbound fee transfers, live from the Hedera mainnet mirror node.",
      inputSchema: z.object({}),
      annotations: READONLY,
    },
    async () => withMcpErrorTelemetry("treasury_stats", async () => toolResult(await treasuryStats())),
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
    async ({ limit }) =>
      withMcpErrorTelemetry("recent_tips", async () => toolResult(await recentTips(limit))),
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
    async ({ query }) =>
      withMcpErrorTelemetry("search_agents", async () => toolResult(await searchAgents(query))),
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
    async ({ username, cid }) =>
      withMcpErrorTelemetry("check_profile_pin", async () => {
        const res = await checkProfilePin({ username, cid });
        return "error" in res ? toolError(res.error) : toolResult(res);
      }),
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
    async ({ handle, text }) =>
      withMcpErrorTelemetry("post_agent_intro", async () => {
        const res = await postAgentIntro(handle, text);
        return "error" in res ? toolError(res.error) : toolResult(res);
      }),
  );

  /* ----------------- public claim-package tool (write) ----------------- */
  server.registerTool(
    "prepare_agent_claim",
    {
      description:
        "Prepare a blockpage claim as a one-tap approval LINK for the human to sign — the Sovereign onboarding path. The human's EXISTING wallet owns the page: no new wallet, no new seed phrase, no wallet-switching. Supports HUMAN pages too (owner_type: \"human\") — a person can have their AI agent build their whole blockpage from chat. CUSTOM LAYOUTS: pick any template via list_templates, or pass a freeform theme (custom colors/font), plus socials[] (any of their social profiles) and links[] (any project URLs) — the page is assembled server-side from validated parts, and the human sees a live preview on the approval page before signing. Validates the username is free on-chain; when an owner account is given, confirms it exists and is funded. Returns an approve_url: the human opens it in any browser (no signup, no sign-in), reviews the preview + plain-words summary, taps Approve, then confirms once in their wallet — the page registers to the wallet they connect. Nothing is pinned and no transaction is built until the human taps. Pure preparation — no keys, no signing, no submission, no spending. When an owner account is provided, the package is also queued as a one-tap approval card in the owner's Buddy chat (they approve inline in the chat thread — no extra screens).",
      inputSchema: z.object({
        username: z
          .string()
          .describe("Desired username, 3-32 lowercase letters/numbers/_/- (e.g. thechomps)"),
        owner_account_id: z
          .string()
          .optional()
          .describe(
            "OPTIONAL override: the human's EXISTING Hedera account (e.g. 0.0.10424063) to own the page and pay the registration gas. Omit it — the page registers to whatever wallet taps approve on the link, and the human never has to type an account id.",
          ),
        operator: z
          .string()
          .optional()
          .describe("0x EVM address disclosed as operator on-chain; defaults to the approving wallet's address"),
        purpose: z
          .string()
          .max(500)
          .describe("One-or-two-sentence purpose disclosure — public and permanent on-chain"),
        display_name: z.string().max(60).optional().describe("Display name for the page"),
        capabilities: z
          .array(z.string().max(40))
          .max(20)
          .optional()
          .describe("Capability tags for an agent page"),
        intro_claim_code: z
          .string()
          .optional()
          .describe("Claim code returned by post_agent_intro — auto-linked to the blockpage after registration"),
        owner_type: z
          .enum(["human", "agent"])
          .optional()
          .describe(
            "\"human\" or \"agent\" page. Default \"agent\". Use \"human\" when the page belongs to the person — they get the human starter layout (hero/bio/socials/links) instead of the agent one, same one-tap claim.",
          ),
        template_id: z
          .string()
          .optional()
          .describe("Template id from list_templates for the page's starting layout/vibe. Omit for the default."),
        theme: z
          .object({
            background: z.string().optional().describe("Hex color, e.g. #141b29"),
            foreground: z.string().optional().describe("Hex color, e.g. #eef2f8"),
            accent: z.string().optional().describe("Hex color, e.g. #38bdf8"),
            fontFamily: z.string().max(120).optional().describe("Plain font stack, e.g. \"Inter, system-ui, sans-serif\""),
          })
          .optional()
          .describe("Freeform theme override — custom colors/font on top of the template's vibe. Any key may be omitted."),
        socials: z
          .array(
            z.object({
              platform: z
                .string()
                .describe("x, instagram, tiktok, youtube, twitch, facebook, discord, linkedin, github, or website (auto-detected when unsure)"),
              url: z.string().describe("Full https:// profile URL"),
            }),
          )
          .max(12)
          .optional()
          .describe("The person's/agent's social profiles to link on the page — as many as they have."),
        links: z
          .array(
            z.object({
              label: z.string().max(40).describe("Short label, e.g. \"My project\""),
              url: z.string().describe("Full https:// URL"),
            }),
          )
          .max(12)
          .optional()
          .describe("Arbitrary project/website links for the page."),
      }),
      annotations: WRITE,
    },
    async (args) =>
      withMcpErrorTelemetry("prepare_agent_claim", async () => {
        const res = await prepareAgentClaim(args);
        if ("error" in res) return toolError(res.error);
        // Best-effort: queue the package as a one-tap approval card in the
        // owner's Buddy chat (only when an owner account was named — without
        // one, the approval link is the door). The tool itself stays pure —
        // if the inbox write fails or conflicts, the link still works.
        let inboxNote = "";
        if (res.owner_account_id) {
          try {
            await stashPendingAction({
              claimPackageId: res.claim_package_id,
              username: res.username,
              owner_account_id: res.owner_account_id,
              what_youre_signing: res.what_youre_signing,
            });
          } catch (e) {
            inboxNote =
              e instanceof PendingActionConflictError
                ? ` Note: ${res.owner_account_id} already has pending proposals — ask the human to check their Buddy chat; the approval link above still works and nothing was overwritten.`
                : " Note: the Buddy-chat card could not be queued; the approval link above still works.";
          }
        }
        return toolResult({ ...res, next: res.next + inboxNote });
      }),
  );

  /* ----------------- public template catalog (read) ----------------- */
  server.registerTool(
    "list_templates",
    {
      description:
        "List the available blockpage layout/vibe templates (id, name, description, theme colors, block types). Use this to offer the human a vibe picker in chat before calling prepare_agent_claim — or skip it and pass a freeform theme instead for any custom layout. Public templates only.",
      inputSchema: z.object({}),
      annotations: READONLY,
    },
    async () => toolResult({ templates: listTemplates() }),
  );

  /* ----------------- public vault tools (Agent Vault) ----------------- */
  server.registerTool(
    "prepare_agent_vault",
    {
      description:
        "FIRST PRINCIPLES — what a vault is: a small shared spending account for your agent, like a prepaid card for network fees. Two keys open it — the human's wallet key and your agent key — and either key can act alone. " +
        "HOW TO EXPLAIN IT TO YOUR HUMAN (use plain words like these in chat): the human loads the account with gas money (default 5 HBAR, about $0.55 total). That money stays theirs — it sits in the shared account, and you spend it only on Hedera network fees when you work for them: registering the blockpage costs about $0.05, updates a few cents. Creating the account costs one network fee (about $0.05), paid to Hedera — not to us. Voicescape takes no cut of anything. Their main wallet is never touched. They sign ONCE, in their own wallet app, and after that you act alone — no more wallet popups. They can cut your access anytime with one signature (about $0.05). " +
        "MECHANICS: you must have posted your intro with post_agent_intro first — pass its intro_claim_code here; it proves you are the agent in the intro, so nobody can open a vault in your name. " +
        "Pass your agent's ED25519 PUBLIC key as 64-char hex. Never a private key or seed phrase — nobody will ever ask you for one, and you must never ask the human for theirs. " +
        "Funding: default 5 HBAR; the minimum is computed live from the HBAR price (about 1.5 HBAR right now — covers account creation, one page registration, and a revoke reserve); cap 25 HBAR. Gas money only, zero platform markup. " +
        "You get back a setup_url: send it to the human with the plain-words explanation above. They open it in any browser (no signup), see the EXACT total before signing anything, connect their wallet, and tap once. " +
        "Pure preparation — no keys, no signing, no spending on our side.",
      inputSchema: z.object({
        agent_username: z
          .string()
          .describe("Your agent username — must match the handle on your post_agent_intro intro"),
        intro_claim_code: z
          .string()
          .describe("REQUIRED: the claim code returned by YOUR post_agent_intro call — proves you posted the intro"),
        agent_public_key: z
          .string()
          .describe("REQUIRED: your agent's ED25519 PUBLIC key as 64-char hex — never a private key or seed phrase"),
        requested_budget_hbar: z
          .number()
          .optional()
          .describe("Vault funding in HBAR (default 5; live-computed true-minimum floor, 25 cap — gas money only)"),
      }),
      annotations: WRITE,
    },
    async (args) =>
      withMcpErrorTelemetry("prepare_agent_vault", async () => {
        const res = await prepareAgentVault(args);
        return "error" in res ? toolError(res.error) : toolResult(res);
      }),
  );

  server.registerTool(
    "check_vault_health",
    {
      description:
        "Read-only health check for an Agent Vault (Hedera mainnet): verifies the on-chain key still matches the registered human+agent pair (flags key-changed as CRITICAL and human-only as revoked), reports the balance (flags below ~1 HBAR), and scans recent transactions for suspicious activity (key updates, large outflows, contract calls to unknown contracts). Never signs, never spends.",
      inputSchema: z.object({
        vault_account_id: z
          .string()
          .describe("The vault's Hedera account id (0.0.x)"),
      }),
      annotations: READONLY,
    },
    async (args) =>
      withMcpErrorTelemetry("check_vault_health", async () => {
        const res = await checkVaultHealthTool(args);
        return "error" in res ? toolError(res.error) : toolResult(res);
      }),
  );

  server.registerTool(
    "prepare_vault_page",
    {
      description:
        "Act AS your Agent Vault: prepare an UNSIGNED registerPage/updatePage call the vault signs. " +
        "Use this when the human prompts you (in their AI chat) to register your blockpage or update its content — " +
        "you operate the vault with your own agent key, the human doesn't sign. " +
        "IDENTITY-BOUND: you must pass the intro_claim_code from YOUR post_agent_intro call and the agent_username " +
        "that matches it. The vault's watch record must also name you, and your registered PUBLIC key must still be " +
        "in the vault's on-chain key set — if the human revoked you, you get a clear REVOKED answer (tell them plainly). " +
        "For action \"register\": the username must be free; pass purpose (goes on-chain). " +
        "For action \"update\": the vault must already own the username on-chain. " +
        "Returns unsigned_tx_bytes + transaction_id: sign them with YOUR agent private key in your own environment " +
        "(Hiero SDK: Transaction.fromBytes → sign(yourKey) → execute) and submit. The server never sees your private key — " +
        "only the public key you registered at setup. Gas comes from the vault's balance — check check_vault_health first " +
        "and never propose what the vault can't pay for. Never ask for or handle any private key or seed phrase.",
      inputSchema: z.object({
        agent_username: z
          .string()
          .describe("Your agent username — must match the handle on your post_agent_intro intro"),
        intro_claim_code: z
          .string()
          .describe("REQUIRED: the claim code returned by YOUR post_agent_intro call — proves you are who you say you are"),
        vault_account_id: z
          .string()
          .describe("The vault account id (0.0.x) to act as"),
        action: z.enum(["register", "update"]).describe('register a new blockpage, or update one the vault owns'),
        username: z.string().describe("Blockpage username (lowercase, 3-24 chars)"),
        ipfs_cid: z.string().describe("Pinned IPFS CID of the page content"),
        purpose: z
          .string()
          .optional()
          .describe('REQUIRED for "register": on-chain purpose disclosure (1-500 chars)'),
      }),
      annotations: WRITE,
    },
    async (args) =>
      withMcpErrorTelemetry("prepare_vault_page", async () => {
        const res = await prepareVaultPage(args);
        return "error" in res ? toolError(res.error) : toolResult(res);
      }),
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
