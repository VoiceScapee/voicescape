/**
 * MCP rate-limit tiering — which tools get the generous read tier.
 *
 * Read-only tools: 100 requests/hour per IP.
 * Write tools (intros, claims, vaults, feedback): 20/hour per IP.
 *
 * This set MUST stay in exact parity with the registry's READONLY
 * annotations (`frontend/lib/server/mcp-tool-registry.ts`): every tool the
 * registry marks read-only MUST be in this set, and nothing else may be.
 * `frontend/app/api/mcp/route.test.ts` enforces this — the suite fails on
 * any drift.
 *
 * (2026-10-04: three read-only tools shipped without being added to the
 * route's tier set and silently throttled at the write tier. The parity
 * test now prevents a repeat.)
 */
export const READONLY_TOOLS = new Set([
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
  "blockpage_earnings",
  "read_agent_messages",
  "list_tip_assets",
]);
