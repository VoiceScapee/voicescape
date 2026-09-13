/**
 * Regulatory countdown beats for the landing page.
 *
 * Crypto doesn't sleep — neither should the landing page. Beats are checked
 * in order; the first beat whose target is still in the future is the live
 * countdown. When a beat passes, the next one takes over automatically on
 * the next tick — no deploy needed between beats.
 *
 * Each beat carries an i18n key prefix; the component reads
 * `${prefix}Label|Title|Body|Note|LiveTitle|LiveBody`.
 *
 * Date-level precision on purpose: agencies announce a day, rarely an hour —
 * we count down to the start of that day (ET) rather than inventing a time.
 */
export interface RegulatoryBeat {
  id: string;
  /** ISO date at start-of-day ET, e.g. "2026-09-17T00:00:00-04:00". */
  targetAt: string;
  /** i18n key prefix, e.g. "landing.clarity" or "landing.secBeat". */
  i18nPrefix: string;
}

export const REGULATORY_BEATS: RegulatoryBeat[] = [
  {
    id: "clarity-vote",
    targetAt: "2026-09-15T00:00:00-04:00",
    i18nPrefix: "landing.clarity",
  },
  {
    id: "sec-24h-roundtable",
    // SEC full-day roundtable on 24-hour equities trading (Sep 17, 2026):
    // 27 panelists incl. BlackRock, Nasdaq, Citadel; 18 already run crypto
    // operations. Reported by crypto.news, Sep 10 2026.
    targetAt: "2026-09-17T00:00:00-04:00",
    i18nPrefix: "landing.secBeat",
  },
  // Next: CFTC beat — add { id: "cftc-...", targetAt: "...", i18nPrefix:
  // "landing.cftcBeat" } here once Brandon confirms the date/event.
];

/** First beat still in the future; falls back to the most recent past beat. */
export function activeBeat(beats: RegulatoryBeat[], nowMs: number): RegulatoryBeat {
  for (const beat of beats) {
    if (Date.parse(beat.targetAt) > nowMs) return beat;
  }
  return beats[beats.length - 1];
}
