/**
 * Voicescape Town Hall — pre-publish content safety filter.
 *
 * Runs synchronously on the write path (forum posts, chat messages,
 * marketplace listings, chatroom titles/descriptions) BEFORE anything is
 * submitted to HCS. HCS is append-only and immutable, so blocked content
 * must never reach the chain — this filter is the last gate.
 *
 * Design notes:
 *  - Pure function, precompiled regexes: runs in well under 1ms on a
 *    5000-char input (the MAX_BODY cap), far below the 5ms budget.
 *  - Deliberately biased toward false POSITIVES for illegal content
 *    (CSAM, terrorism, violent threats, doxxing): a blocked legit message
 *    is a support ticket; a published illegal message is a platform risk.
 *  - Gray-area content (harassment, spam, scams) is NOT blocked here —
 *    it goes through user reporting + moderator hide actions instead.
 *  - Reasons are categorical ("threats of violence") and never echo the
 *    matched text, so error payloads can't be used to exfiltrate the
 *    blocklist or re-publish the offending content.
 */

export interface ContentCheckResult {
  allowed: boolean;
  /** Categorical reason, e.g. "threats of violence". Present when blocked. */
  reason?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ */
/* Blocklists                                                         */
/* ------------------------------------------------------------------ */

/**
 * High-signal phrases associated with child sexual abuse material.
 * Kept to unambiguous terms — gray-area content is handled via
 * reporting + moderation, not this filter.
 */
const CSAM_PHRASES = [
  "child porn",
  "child pornography",
  "childporn",
  "cp trade",
  "trade cp",
  "cp video",
  "cp link",
  "cp drop",
  "cp mega",
  "preteen",
  "preteens",
  "jailbait",
];

/** Named terrorist organizations (recruitment/propaganda signal). */
const TERROR_PHRASES = [
  "isis",
  "isil",
  "al-qaeda",
  "al qaeda",
  "alqaeda",
  "boko haram",
  "al-shabaab",
  "al shabaab",
  "alshabaab",
];

/**
 * Explicit violent-threat patterns. First-person violent intent,
 * mass-violence threats, and bomb threats.
 */
const THREAT_PATTERNS = [
  /\bi(?:'m| am|m|mma)?\s+(?:gonna|going to|will)\s+(?:kill|murder|shoot|stab|strangle|behead)\b/i,
  /\bi\s+will\s+bomb\b/i,
  /\bgoing\s+to\s+bomb\b/i,
  /\bbomb\s+threat\b/i,
  /\bshoot\s*up\b/i,
  /\bkill\s+yourself\b/i,
];

/* ------------------------------------------------------------------ */
/* Doxxing: SSN + payment-card patterns                               */
/* ------------------------------------------------------------------ */

/** US Social Security Number shape: 123-45-6789 / 123 45 6789. */
const SSN_RE = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/;

/** 13–19 digit run with optional separators — candidate card number. */
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/;

/** Luhn check: weeds out random digit runs so only plausible card numbers block. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

/* ------------------------------------------------------------------ */
/* Precompiled matchers (module load, not per call)                   */
/* ------------------------------------------------------------------ */

const CSAM_RE = new RegExp(`\\b(?:${CSAM_PHRASES.map(escapeRegExp).join("|")})\\b`, "i");
const TERROR_RE = new RegExp(`\\b(?:${TERROR_PHRASES.map(escapeRegExp).join("|")})\\b`, "i");

/**
 * Check user-supplied text before it is published.
 *
 * @param text  The field value to check.
 * @param label Human-readable field name used in the blocked reason
 *              (e.g. "post body", "listing description"). Never echoed
 *              with the matched content.
 */
export function checkContent(text: string, label = "content"): ContentCheckResult {
  if (!text || typeof text !== "string") return { allowed: true };
  const blocked = (reason: string): ContentCheckResult => ({
    allowed: false,
    reason: `${label} blocked: ${reason}`,
  });

  // Cheapest checks first.
  if (CSAM_RE.test(text)) return blocked("sexual content involving minors is prohibited");
  if (TERROR_RE.test(text)) return blocked("terrorist content is prohibited");
  for (const re of THREAT_PATTERNS) {
    // Reset lastIndex defensively (patterns are non-global, but cheap insurance).
    re.lastIndex = 0;
    if (re.test(text)) return blocked("threats of violence are prohibited");
  }
  if (SSN_RE.test(text)) return blocked("posting personal identification numbers (SSN) is prohibited");

  // Card candidates: strip separators, require 13–19 digits + Luhn.
  // Manual scan avoids catastrophic backtracking on long inputs.
  let m: RegExpExecArray | null;
  CARD_CANDIDATE_RE.lastIndex = 0;
  const cardRe = new RegExp(CARD_CANDIDATE_RE.source, "g");
  while ((m = cardRe.exec(text)) !== null) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      return blocked("posting payment card numbers is prohibited");
    }
    // Guard against zero-length matches looping forever.
    if (m[0].length === 0) cardRe.lastIndex++;
  }
  return { allowed: true };
}
