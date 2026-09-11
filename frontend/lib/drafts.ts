/**
 * Deep-link page drafts for the Builder (`/builder?draft=<name>`).
 *
 * Drafts are static JSON files served from `/drafts/<name>.json`
 * (see `frontend/public/drafts/`). The name is strictly sanitized so it
 * can only ever resolve to a file inside that directory — no path
 * traversal, no extensions, no query tricks.
 */

const DRAFT_NAME_RE = /^[a-z0-9-]{1,32}$/;

/**
 * Normalize + validate a raw `?draft=` query value.
 * Returns the safe draft name, or null when the value is unusable.
 */
export function sanitizeDraftName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw.trim().toLowerCase();
  return DRAFT_NAME_RE.test(name) ? name : null;
}

/** Public URL of a sanitized draft's JSON file. */
export function draftFileUrl(name: string): string {
  return `/drafts/${name}.json`;
}
