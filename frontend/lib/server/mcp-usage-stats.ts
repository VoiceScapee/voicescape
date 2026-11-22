/**
 * Anonymous MCP visitor stats (Brandon 2026-10-01: "tell me how many agents
 * are actually visiting the mcp").
 *
 * Every tool call increments four aggregate counters in KV — no IPs, no
 * arguments, no wallet data, nothing that identifies anyone:
 *
 *   - mcp:stats:calls:total                all-time-ish (30d rolling TTL)
 *   - mcp:stats:calls:tool:{name}          LEGACY per-tool totals — still
 *     written, never read for windowed counts: its TTL is set once at
 *     creation, so it spans whatever 30 days followed that tool's FIRST
 *     call, not the last 30 days. Superseded by the tool-day keys below.
 *   - mcp:stats:calls:tool-day:{name}:{YYYY-MM-DD}
 *                                            per-tool totals, one key per
 *     tool per calendar day — the same window shape as the day keys, so
 *     byTool is a true 30-day window (2026-11-22 fix).
 *   - mcp:stats:calls:day:{YYYY-MM-DD}      per-day totals (last 30 days)
 *
 * 30-day TTL on every key: the numbers describe recent activity, and stale
 * keys evaporate on their own. Best-effort — recording never throws and
 * never changes what the agent receives.
 *
 * Honest limitation (2026-11-22): the tool-day keys only start accumulating
 * at deploy. byTool reads them, so it undercounts the total until 30 days
 * of tool-day data exists — history the legacy per-tool keys already lost
 * cannot be recovered.
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
  "reply_to_intro",
  "prepare_agent_claim",
  "propose_page_update",
  "request_capability_token",
  "set_agent_availability",
  "stage_page_draft",
  "send_agent_message",
  "check_grant_status",
  "prepare_agent_self_claim",
  "finalize_agent_self_claim",
  "complete_agent_self_claim",
  "release_reservation",
  "self_fund_hedera",
  "prepare_nft_collection",
  "prepare_nft_mint",
  "get_nft_collection",
  "create_nft_drop",
  "finalize_nft_drop",
  "prepare_nft_transfer",
  "check_claim_status",
  "list_templates",
  "prepare_agent_vault",
  "prepare_milestone_commit",
  "verify_milestone_commit",
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
  "prepare_tip",
  "pay_x402_service",
  "prepare_airdrop",
  "check_pending_airdrops",
  "request_purchase_approval",
  "follow_creator",
  "unfollow_creator",
  "post_hire_review",
  "request_review_approval",
  "create_fundraiser",
  "manage_music",
  "prepare_memecoin_launch",
] as const;

function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Last 30 calendar days (UTC), newest first — the one window byDay, byTool and total share. */
function last30Days(): string[] {
  const days: string[] = [];
  for (let i = 0; i < 30; i++) {
    days.push(dayKey(new Date(Date.now() - i * 86_400_000)));
  }
  return days;
}

/** Batch-read values in key order. Uses store.mget when the backend offers it, else falls back to one get() per key. */
async function mgetAll(store: KvStore, keys: string[]): Promise<(string | null)[]> {
  if (keys.length === 0) return [];
  if (store.mget) {
    // Bound the request size (Upstash REST takes the keys as one JSON body).
    const out: (string | null)[] = [];
    for (let i = 0; i < keys.length; i += 500) {
      out.push(...(await store.mget(keys.slice(i, i + 500))));
    }
    return out;
  }
  return Promise.all(keys.map((k) => store.get(k)));
}

function parseCount(v: string | null | undefined): number {
  return v ? parseInt(v, 10) || 0 : 0;
}

export interface McpUsageStats {
  /**
   * Total tool calls in the rolling 30-day window — the SUM of the
   * per-day counters. byTool is the sum of the per-tool-per-day counters
   * over the same 30 calendar days, so total, byTool, and byDay all
   * describe one consistent window. Deliberately NOT the standalone
   * `mcp:stats:calls:total` counter: its TTL is set once at creation,
   * so it spans whatever 30 days followed its first call, while the day
   * keys span the last 30 calendar days — reading it made the three
   * numbers contradict each other on the same response.
   */
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
      // Legacy aggregate — still written, never read for windowed counts.
      store.incr(`${PREFIX}:tool:${name}`, TTL_MS),
      // Windowed source: one key per tool per calendar day, same shape
      // as the day keys, so byTool spans the last 30 days like byDay.
      store.incr(`${PREFIX}:tool-day:${name}:${dayKey()}`, TTL_MS),
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
    const stats: McpUsageStats = {
      total: 0,
      byTool: {},
      byDay: {},
    };
    const days = last30Days();
    // Per-tool totals — summed from the per-tool-per-day keys over the
    // same 30 calendar days as byDay. NEVER from the legacy
    // `${PREFIX}:tool:{name}` keys: each of those expires 30 days after
    // that tool's first call, so it spans a different window per tool
    // and undercounts the total (2026-11-22: byTool summed to 1231
    // against a total of 1876).
    const toolDayKeys: string[] = [];
    for (const t of KNOWN_MCP_TOOLS) {
      for (const d of days) toolDayKeys.push(`${PREFIX}:tool-day:${t}:${d}`);
    }
    const toolDayVals = await mgetAll(store, toolDayKeys);
    KNOWN_MCP_TOOLS.forEach((t, i) => {
      let n = 0;
      for (let j = 0; j < 30; j++) n += parseCount(toolDayVals[i * 30 + j]);
      if (n > 0) stats.byTool[t] = n;
    });
    // Last 30 days of day-keys.
    const dayVals = await mgetAll(store, days.map((k) => `${PREFIX}:day:${k}`));
    dayVals.forEach((v, i) => {
      const n = parseCount(v);
      if (n > 0) stats.byDay[days[i]] = n;
    });
    // Total = sum of the per-day counters: the one window all three
    // numbers share. The standalone `${PREFIX}:total` counter is still
    // written by recordMcpToolCall (raw all-time-ish counter) but is
    // never read here — its create-once TTL spans a different 30 days
    // than the day keys, which is what made total disagree with
    // sum(byTool) and sum(byDay) on the same response.
    stats.total = Object.values(stats.byDay).reduce((a, b) => a + b, 0);
    return stats;
  } catch {
    return empty;
  }
}

/**
 * Read per-tool counters for a known tool list. The MCP route passes its
 * registered tool names so the response only names real tools. Counts are
 * the last 30 calendar days, summed from the per-tool-per-day keys — the
 * same windowed source as getMcpUsageStats, never the legacy per-tool
 * aggregate keys (their create-once TTL anchors to each tool's first
 * call, so they undercount the window; see the header note).
 */
export async function getMcpToolCounts(
  toolNames: string[],
  deps: { store?: KvStore } = {},
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of toolNames) out[t] = 0;
  try {
    const store = deps.store ?? getKvStore();
    const days = last30Days();
    const keys: string[] = [];
    for (const t of toolNames) {
      for (const d of days) keys.push(`${PREFIX}:tool-day:${t}:${d}`);
    }
    const vals = await mgetAll(store, keys);
    toolNames.forEach((t, i) => {
      let n = 0;
      for (let j = 0; j < 30; j++) n += parseCount(vals[i * 30 + j]);
      out[t] = n;
    });
  } catch {
    /* fall through with zeros */
  }
  return out;
}
