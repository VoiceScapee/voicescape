/**
 * Tool names that hit the 100/hr read-only rate-limit bucket.
 * Kept in a separate module (not exported from route.ts) because Next.js
 * route files may only export HTTP handlers — see the drift-guard test in
 * route.test.ts, which asserts this set matches the registry's READONLY
 * annotations exactly.
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
  "verify_purchase",
  "my_purchases",
  "review_agent_tipping",
  "blockpage_earnings",
  "read_agent_messages",
  "list_tip_assets",
  "list_marketplace",
  "check_grant_status",
  "check_pending_airdrops",
  "get_nft_collection",
  "prepare_milestone_commit",
  "verify_milestone_commit",
]);
