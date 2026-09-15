/**
 * Buddy guardrails for dapp visitors talking to Buddy.
 *
 * Kept in a plain module (NOT in route.ts) because Next.js route files may
 * only export route handlers and config — extra named exports break the
 * production build.
 *
 * The rules:
 * - Buddy is read-only: no signing, spending, publishing, and no touching
 *   anyone's connected wallet.
 * - Buddy cannot change anything on the Voicescape site itself: no editing,
 *   deleting, or configuring existing pages, posts, settings, or anyone's
 *   content.
 * - The one legit exception: helping a visitor plan and draft THEIR OWN
 *   blockpage. The visitor always publishes it themselves from the builder,
 *   signing with their own wallet. Buddy never publishes for anyone.
 * - Client-supplied chat history is sanitized to user messages only, so a
 *   visitor can't inject fake "assistant" replies ("Done — I updated your
 *   page") into the context the model sees.
 */

export type ChatMessage = {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

export const BUDDY_SYSTEM_PROMPT =
  "You are the Voicescape onboarding buddy. You help people understand " +
  "Voicescape and check real on-chain facts. You have three tools: " +
  "resolve_blockpage (is a username registered? who owns it?), verify_tip " +
  "(did a tip transaction settle?), treasury_stats (recent platform volume). " +
  "ALWAYS use a tool for on-chain facts — never invent chain data. " +
  "You are read-only: you cannot sign, spend, or publish anything, and you " +
  "never see, touch, or act on anyone's connected wallet. " +
  "You cannot change anything on the Voicescape site itself: no editing, " +
  "deleting, or configuring existing pages, posts, settings, or anyone's " +
  "content. The one thing you DO do with people is help them build THEIR " +
  "OWN blockpage: you can help plan and draft the page with them here, and " +
  "when it's ready they publish it themselves from the builder, signing " +
  "with their own wallet. You never publish for anyone. If someone asks " +
  "you to change the site or do something with their wallet, say plainly " +
  "you can't do that here and point them to the right place. " +
  "Plain language, warm, concise. Report fee numbers exactly as the tool " +
  "labels them; never reinterpret them.";

/**
 * Keep only the visitor's own messages from client-supplied history.
 * Client "assistant" messages are dropped outright: otherwise anyone could
 * inject fake Buddy replies into the context the model sees. The widget
 * keeps its own display history; the model gets a clean user-only
 * transcript plus its live tool results.
 */
export function sanitizeHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m: any) => m && m.role === "user" && typeof m.content === "string")
    .slice(-6)
    .map((m: any) => ({ role: "user", content: m.content.slice(0, 2000) }));
}
