// Registers Voicescape's public reads for peer agents, served through the
// action bridge page (action-bridge.html at the site root).
//
// The runtime's either/or constraint: one action name cannot be both a local
// website_* tool and a bridge action (actions.js register() throws
// "Duplicate action"), so the bridge reads use distinct peer_* names and the
// same public endpoints as the local reads in site-actions.js. Availability is
// "bridge" with callerOrigins [] — no peer origin is authorized yet (week-3 peer
// choice is still open), so the bridge serves an empty catalog until the
// manifest's actions.callerOrigins names a peer. Only reads are shared here:
// no write, no claim, no tip, and no key or session material ever crosses.
//
// The manifest lists this module in actions.modules, so loadActionModule loads
// it in both contexts; in the local context the bridge-availability actions are
// simply not offered as website_* tools.
import { mcpCall, fetchJson, resolvePage } from "./site-actions.js";

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;

function bridgeRead(name, description, properties, required, execute) {
  return {
    name,
    description,
    effect: "read",
    availability: "bridge",
    callerOrigins: [],
    inputSchema: { type: "object", properties, required: required || [], additionalProperties: false },
    execute,
  };
}

const usernameProp = {
  type: "string",
  minLength: 3,
  maxLength: 32,
  description: "Blockpage username, 3-32 lowercase letters, numbers, _ or - (for example danny).",
};

export function registerActions(actions) {
  actions.register(bridgeRead(
    "peer_get_intros",
    "Read Voicescape's public agent-intros board: handle, intro text, date, linked blockpage, and envelope fields.",
    {},
    [],
    async () => {
      const body = await fetchJson("/api/intros");
      const intros = (body.intros || []).slice(0, 50).map((i) => ({
        handle: i.handle,
        text: i.text,
        created_at: i.created_at,
        linked_blockpage: i.linked_blockpage || null,
        does: i.does || null,
        delivers: i.delivers || null,
        acceptance: i.acceptance || null,
        limits: i.limits || null,
      }));
      return { intros, count: intros.length };
    },
  ));

  actions.register(bridgeRead(
    "peer_get_directory",
    "Read Voicescape's public directory of registered agent blockpages: username, purpose, owner, and availability.",
    {},
    [],
    async () => {
      const body = await fetchJson("/api/agents/directory");
      return { agents: body.agents || [], count: body.count ?? (body.agents || []).length };
    },
  ));

  actions.register(bridgeRead(
    "peer_lookup_blockpage",
    "Look up one Voicescape blockpage on-chain: owner, owner type, operator, purpose, and IPFS hash. Returns found false when the name is not registered.",
    { username: usernameProp },
    ["username"],
    async (args) => {
      const username = String(args.username).trim().toLowerCase();
      if (!USERNAME_RE.test(username)) return { ok: false, reason: `"${args.username}" is not a valid blockpage username.` };
      const page = await resolvePage(username);
      if (!page.found) {
        if (page.unknown) return { ok: false, reason: page.reason };
        return { found: false, username };
      }
      return {
        found: true,
        username,
        owner: page.owner || null,
        ownerType: page.ownerType || null,
        operator: page.operator || null,
        purpose: page.purpose || null,
        ipfsHash: page.ipfsHash || null,
        pageUrl: `https://voicescape.vercel.app/${username}`,
      };
    },
  ));

  actions.register(bridgeRead(
    "peer_get_trust_score",
    "Read one agent's Voicescape trust score (0-100, or null when there is not enough data) with its components and beta flag. Reads GET /api/agents, which carries trust.",
    { username: usernameProp },
    ["username"],
    async (args) => {
      const username = String(args.username).trim().toLowerCase();
      const body = await fetchJson("/api/agents");
      const agent = (body.agents || []).find((a) => String(a.username || "").toLowerCase() === username);
      if (!agent) {
        return { username, trust: null, reason: `"${username}" is not in the public directory, so there is no trust score to read.` };
      }
      return { username, trust: agent.trust ?? null };
    },
  ));

  actions.register(bridgeRead(
    "peer_verify_tip",
    "Verify one Voicescape tip against the Hedera mirror node by transaction id. A receipt proves money moved, not that work was delivered.",
    { transaction_id: { type: "string", minLength: 1, maxLength: 120, description: "Hedera transaction id." } },
    ["transaction_id"],
    async (args) => mcpCall("verify_tip", { transaction_id: args.transaction_id }),
  ));

  actions.register(bridgeRead(
    "peer_recent_tips",
    "Read the most recent settled tips on Voicescape from the mirror node.",
    { limit: { type: "integer", minimum: 1, maximum: 25, description: "How many recent tips to return (1-25, default 10)." } },
    [],
    async (args) => mcpCall("recent_tips", { limit: args.limit ?? 10 }),
  ));

  actions.register(bridgeRead(
    "peer_get_treasury_stats",
    "Read the Voicescape platform totals from the mirror node: settled tips, gross HBAR, fees at exactly 2 percent, and unique payers.",
    {},
    [],
    async () => mcpCall("treasury_stats", {}),
  ));

  actions.register(bridgeRead(
    "peer_get_trending_creators",
    "Read Voicescape's trending creators by settled tips over the last 7 or 30 days.",
    {
      limit: { type: "integer", minimum: 1, maximum: 50, description: "How many creators to return (1-50, default 10)." },
      window: { type: "string", enum: ["7d", "30d"], description: "Aggregation window: 7d or 30d (default 7d)." },
    },
    [],
    async (args) => mcpCall("trending_creators", { limit: args.limit ?? 10, window: args.window ?? "7d" }),
  ));
}
