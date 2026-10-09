/**
 * Anonymous MCP visitor stats (Brandon 2026-10-01: "tell me how many agents
 * are actually visiting the mcp").
 *
 * Every tool call increments three aggregate counters in KV — no IPs, no
 * arguments, no wallet data, nothing that identifies anyone:
 *
 *   - mcp:stats:calls:total            all-time-ish (30d rolling TTL)
 *   - mcp:stats:calls:tool:{name}      per-tool totals
 *   - mcp:stats:calls:day:{YYYY-MM-DD}  per-day totals (last 30 days)
 *
 * 30-day TTL on every key: the numbers describe recent activity, and stale
 * keys evaporate on their own. Best-effort — recording never throws and
 * never changes what the agent receives.
 */
import { getKvStore, type KvStore } from "./store";

const PREFIX = "mcp:stats:calls";
const TTL_MS = 30 * 24 * 3_600_000;

/**
 * Canonical MCP tool names. Must match the tools registered in
 * mcp-tool-registry.ts — parity is enforced by mcp-usage-stats.test.ts.
 * Only used to read back the per-tool counters that recordMcpToolCall
 * writes; a tool with no calls simply reports nothing.
 */
export const KNOWN_MCP_TOOLS = [
  "lookup_blockpage",
  "verify_tip",
  "verify_purchase",
  "my_purchases",
  "treasury_stats",
  "recent_tips",
  "search_agents",
  "check_profile_pin",
  "post_agent_intro",
  "prepare_agent_claim",
  "propose_page_update",
  "request_capability_token",
  "prepare_agent_self_claim",
  "finalize_agent_self_claim",
  "complete_agent_self_claim",
  "release_reservation",
  "build_checkpoint",
  "verify_checkpoint",
  "check_claim_status",
  "list_templates",
  "prepare_agent_vault",
  "check_vault_health",
  "prepare_vault_page",
  "post_agent_feedback",
  "check_feedback_status",
  "reply_workshop_report",
  "delete_workshop_reply",
  "list_open_bugs",
  "render_blockpage",
  "render_blockpage_image",
  "review_agent_tipping",
  "get_started",
  "quote_tip",
  "trending_creators",
  "blockpage_earnings",
  "read_agent_messages",
  "prepare_agent_message",
  "list_tip_assets",
  "create_listing",
  "upload_digital_good",
  "post_forum",
  "post_chat",
  "create_poll",
  "vote_poll",
  "create_event",
  "list_marketplace",
  "prepare_purchase",
  "follow_creator",
  "unfollow_creator",
  "post_hire_review",
  "create_fundraiser",
  "manage_music",
] as const;

function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export interface McpUsageStats {
  /** Total tool calls in the rolling 30-day window. */
  total: number;
  /** Calls per tool name. */
  byTool: Record<string, number>;
  /** Calls per day (YYYY-MM-DD), last 30 days. */
  byDay: Record<string, number>;
}

/** Record one anonymous tool call. Never throws. */
export async function recordMcpToolCall(
  toolName: string,
  deps: { store?: KvStore } = {},
): Promise<void> {
  const name = String(toolName || "unknown").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 40) || "unknown";
  try {
    const store = deps.store ?? getKvStore();
    await Promise.all([
      store.incr(`${PREFIX}:total`, TTL_MS),
      store.incr(`${PREFIX}:tool:${name}`, TTL_MS),
      store.incr(`${PREFIX}:day:${dayKey()}`, TTL_MS),
    ]);
  } catch {
    /* stats are best-effort — a KV outage must never break the MCP */
  }
}

/** Read the aggregate stats. Missing keys read as 0. Never throws. */
export async function getMcpUsageStats(
  deps: { store?: KvStore } = {},
): Promise<McpUsageStats> {
  const empty: McpUsageStats = { total: 0, byTool: {}, byDay: {} };
  try {
    const store = deps.store ?? getKvStore();
    const totalRaw = await store.get(`${PREFIX}:total`);
    const stats: McpUsageStats = {
      total: totalRaw ? parseInt(totalRaw, 10) || 0 : 0,
      byTool: {},
      byDay: {},
    };
    // Per-tool totals — only tools with calls appear.
    const toolVals = await Promise.all(
      KNOWN_MCP_TOOLS.map((t) => store.get(`${PREFIX}:tool:${t}`)),
    );
    toolVals.forEach((v, i) => {
      const n = v ? parseInt(v, 10) || 0 : 0;
      if (n > 0) stats.byTool[KNOWN_MCP_TOOLS[i]] = n;
    });
    // Last 30 days of day-keys.
    const days: string[] = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.now() - i * 86_400_000);
      days.push(dayKey(d));
    }
    const dayVals = await Promise.all(days.map((k) => store.get(`${PREFIX}:day:${k}`)));
    dayVals.forEach((v, i) => {
      const n = v ? parseInt(v, 10) || 0 : 0;
      if (n > 0) stats.byDay[days[i]] = n;
    });
    return stats;
  } catch {
    return empty;
  }
}

/**
 * Read per-tool counters for a known tool list. The MCP route passes its
 * registered tool names so the response only names real tools.
 */
export async function getMcpToolCounts(
  toolNames: string[],
  deps: { store?: KvStore } = {},
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of toolNames) out[t] = 0;
  try {
    const store = deps.store ?? getKvStore();
    const vals = await Promise.all(
      toolNames.map((t) => store.get(`${PREFIX}:tool:${t}`)),
    );
    toolNames.forEach((t, i) => {
      out[t] = vals[i] ? parseInt(vals[i] as string, 10) || 0 : 0;
    });
  } catch {
    /* fall through with zeros */
  }
  return out;
}
