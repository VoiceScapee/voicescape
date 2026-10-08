/**
 * Frozen widget beacon spec constants (2026-10-07, v1.0).
 *
 * The beacon shape is {wid, iid} — see
 * frontend/docs/widget-beacon-spec.md. These error codes are part of the
 * frozen contract: autonomaavalix builds assert-on-ingest checks against
 * them. Renaming a code requires a spec version bump and consumer notice.
 */

/** Machine-readable error codes for POST /api/widget-visit. */
export const WIDGET_VISIT_ERRORS = {
  INVALID_WID:
    "wid must be an 8-char widget-instance id issued by render_blockpage",
  UNKNOWN_WID: "wid was not issued by this server",
  MISSING_IID:
    "iid (invocation id) is required — pass the _iid from render_blockpage",
} as const;

export type WidgetVisitErrorCode = keyof typeof WIDGET_VISIT_ERRORS;

/** Frozen beacon spec version. */
export const WIDGET_BEACON_SPEC_VERSION = "1.0";
