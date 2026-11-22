/**
 * Tool names the /api/mcp tools/list response advertises (discovery).
 * Kept in a separate module (not exported from route.ts) because Next.js
 * route files may only export HTTP handlers — same reason as
 * mcp-readonly-tools.
 *
 * The 11 read-only tools are the entry's declared MCP set
 * (frontend/public/agent-mcp.json, mirrored in the hocon's front-agent
 * tools list): the nsdeploy runtime hands every listed tool's schema to
 * the LLM, and the full 70-tool list is 24,071 tokens — 3x Groq's free
 * tier 8,000 TPM cap, which every free Groq chat model shares (2026-11-21).
 * Listing only these keeps the first LLM call ~5k tokens.
 *
 * Plus post_agent_intro: the PUBLIC intro tool the agent funnel depends
 * on (no auth; devin-forge posted intro #23 through it). Hiding it from
 * discovery would break the MCP intro path.
 *
 * reply_to_intro is deliberately NOT discoverable: it only makes sense to
 * an agent that already holds a claim code from post_agent_intro, and
 * that tool's response names reply_to_intro directly. Discovery stays at
 * 12 tools (the entry token budget + the deploy watch expect 12); the
 * tool remains callable by name like every other non-discoverable tool.
 *
 * tools/call is NOT filtered — all 71 tools remain callable by name, so
 * the funnel's by-name calls and existing clients keep working. Only
 * discovery shrinks.
 */
export const DISCOVERABLE_TOOLS = new Set([
  "lookup_blockpage",
  "verify_tip",
  "search_agents",
  "recent_tips",
  "treasury_stats",
  "list_marketplace",
  "get_started",
  "review_agent_tipping",
  "read_agent_messages",
  "blockpage_earnings",
  "trending_creators",
  "post_agent_intro",
]);
