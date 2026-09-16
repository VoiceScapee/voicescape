/**
 * Buddy's builder handoff: extracting a complete page draft from chat.
 *
 * When Buddy finishes building a blockpage, it emits the full page as a
 * single ```json fenced block. The widget hides that machine handoff and
 * offers "Open in Builder" instead — but only when the JSON validates as
 * a real Voicescape page (isValidPage), so a malformed draft can never
 * reach the builder.
 */
import { isValidPage, type VoicescapePage } from "./schema";

/** The fenced-block marker Buddy uses for page drafts. */
export const PAGE_DRAFT_FENCE = /```json\s*([\s\S]*?)```/;

/**
 * Pull a complete Buddy-built page out of an assistant reply. Returns the
 * page when the fenced JSON parses and validates, else null.
 */
export function extractPageDraft(content: string): VoicescapePage | null {
  const m = content.match(PAGE_DRAFT_FENCE);
  if (!m) return null;
  try {
    const data: unknown = JSON.parse(m[1]);
    return isValidPage(data) ? data : null;
  } catch {
    return null;
  }
}

/** Remove the machine-readable draft block so the visitor only sees prose. */
export function stripPageDraft(content: string): string {
  return content.replace(PAGE_DRAFT_FENCE, "").trim();
}
