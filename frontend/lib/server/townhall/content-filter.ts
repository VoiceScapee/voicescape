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
/* Profanity: common strong profanities (word-boundary matched).      */
/* Kept to unambiguous terms; mild slang is left to user reporting.   */
/* ------------------------------------------------------------------ */

const PROFANITY_WORDS = [
  "fuck", "fucks", "fucked", "fucking", "fucker", "fuckers", "fuckface", "fuckoff",
  "motherfucker", "motherfuckers", "motherfucking",
  "shit", "shits", "shitty", "shitting", "bullshit", "horseshit", "dipshit", "dumbshit",
  "bitch", "bitches", "bitchy", "sonofabitch",
  "asshole", "assholes", "arsehole",
  "dick", "dicks", "dickhead", "dickheads",
  "piss", "pissed", "pissing",
  "cock", "cocks", "cocksucker", "cocksuckers",
  "tits", "titties",
  "whore", "whores", "whoring",
  "slut", "sluts", "slutty",
  "bastard", "bastards",
  "crap", "crappy",
  "douche", "douchebag", "douchebags",
  "jackass", "jackasses",
  "prick", "pricks",
];

/**
 * Hate-speech slurs. Unambiguous slurs targeting protected groups.
 * This list is intentionally narrow — reclaimed or context-dependent
 * terms are handled via user reporting + moderation, not auto-block.
 */
const SLUR_WORDS = [
  // Anti-Black
  "nigger", "niggers", "nigga", "niggas",
  // Anti-Asian
  "chink", "chinks", "gook", "gooks",
  // Anti-Latino
  "spic", "spics", "wetback", "wetbacks", "beaner", "beaners",
  // Antisemitic
  "kike", "kikes", "hebe", "hebes",
  // Anti-Arab / anti-Muslim
  "towelhead", "towelheads", "sandnigger", "sandniggers",
  // Anti-Indigenous / misc ethnic
  "redskin", "redskins", "squaw",
  // Anti-LGBTQ+
  "faggot", "faggots", "fag", "fags", "dyke", "dykes", "tranny", "trannies", "shemale",
  // Anti-Roma
  "gypsy", // often used as slur; context-dependent but blocked per strict policy
  // Misogynistic slurs
  "cunt", "cunts",
];

/* ------------------------------------------------------------------ */
/* Personal contact info: email + phone. Blocked because HCS content  */
/* is immutable — a posted phone number can never be taken back.      */
/* Users can share contact details via DMs instead.                   */
/* ------------------------------------------------------------------ */

/** Basic email shape. */
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/**
 * Phone-number shapes: +1 (555) 123-4567, 555-123-4567, 555.123.4567,
 * 555 123 4567. A separator (space, dash, dot, parens) or leading + is
 * required so plain digit runs (order numbers, account IDs) don't match.
 * digitCount() then confirms 10+ digits.
 */
const PHONE_RE = /\+?\d[\d().\- ]*[().\- ][\d().\- ]*\d/;

/** Count digits in a candidate to confirm it's really a phone number. */
function digitCount(s: string): number {
  let n = 0;
  for (const c of s) if (c >= "0" && c <= "9") n++;
  return n;
}

/* ------------------------------------------------------------------ */
/* Links: extraction, safety, and spam.                               */
/* ------------------------------------------------------------------ */

/** Extract http(s) URLs plus bare www./domain.tld mentions. */
const URL_EXTRACT_RE = /\b(?:https?:\/\/[^\s<>"')\]]+|www\.[^\s<>"')\]]+|[a-z0-9-]+\.(?:com|net|org|io|xyz|link|click|top|site|online|store|app|dev|gg|tv|cc|ru|cn|tk)\b[^\s<>"')\]]*)/gi;

/** Dangerous URL schemes — never allowed in user content. */
const DANGEROUS_SCHEME_RE = /\b(?:javascript|data|vbscript|file):/i;

/**
 * Curated blocklist of domains associated with phishing, malware, and
 * crypto-drainer scams. This is a first line of defense, not exhaustive —
 * suspicious links should also be reported by users for mod review.
 */
const MALICIOUS_DOMAINS = [
  // Commonly abused free-hosting / URL-shortener-adjacent phishing hosts
  "bit.ly", "tinyurl.com", // shorteners are spam-obfuscation, blocked in posts
  "discord-nitro", "steamcommunity-nitro",
  "metamask-rewards", "metamask.io-claim",
  "hashpack-claim", "hashpack-rewards",
  "airdrop-claim", "claim-airdrop",
  "free-mint", "mint-free",
  "wallet-verify", "verify-wallet",
  "drainer",
];

/** Max URLs before content is treated as link spam. */
export const MAX_URLS_PER_POST = 3;

/**
 * Validate a single URL (for profile links, listing fields, etc.).
 * Returns { allowed, reason? } — reason is categorical, never echoes input.
 */
export function checkUrl(raw: string, label = "link"): ContentCheckResult {
  if (!raw || typeof raw !== "string") return { allowed: false, reason: `${label} is required` };
  const blocked = (reason: string): ContentCheckResult => ({
    allowed: false,
    reason: `${label} blocked: ${reason}`,
  });
  const trimmed = raw.trim();
  if (trimmed.length > 500) return blocked("URL is too long");
  if (DANGEROUS_SCHEME_RE.test(trimmed)) return blocked("unsafe URL scheme is not allowed");
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return blocked("URL is malformed");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return blocked("only http(s) URLs are allowed");
  }
  const host = url.hostname.toLowerCase();
  if (!host || host.length > 253) return blocked("URL host is invalid");
  for (const bad of MALICIOUS_DOMAINS) {
    if (host === bad || host.endsWith(`.${bad}`) || host.includes(bad)) {
      return blocked("URL points to a known phishing/scam domain");
    }
  }
  // Credential-phishing pattern: userinfo in URL (https://user@evil.com).
  if (url.username || url.password) return blocked("URLs with embedded credentials are not allowed");
  return { allowed: true };
}

/* ------------------------------------------------------------------ */
/* Spam heuristics (stateless).                                       */
/* ------------------------------------------------------------------ */

/** 8+ identical characters in a row: "aaaaaaaa", "!!!!!!!!". */
const REPEATED_CHAR_RE = /(.)\1{7,}/;

/** Same word 5+ times in a row: "buy buy buy buy buy". */
const REPEATED_WORD_RE = /\b(\w+)(?:\s+\1){4,}\b/i;

/* ------------------------------------------------------------------ */
/* Precompiled matchers (module load, not per call)                   */
/* ------------------------------------------------------------------ */

const CSAM_RE = new RegExp(`\\b(?:${CSAM_PHRASES.map(escapeRegExp).join("|")})\\b`, "i");
const TERROR_RE = new RegExp(`\\b(?:${TERROR_PHRASES.map(escapeRegExp).join("|")})\\b`, "i");
const PROFANITY_RE = new RegExp(`\\b(?:${PROFANITY_WORDS.map(escapeRegExp).join("|")})\\b`, "i");
const SLUR_RE = new RegExp(`\\b(?:${SLUR_WORDS.map(escapeRegExp).join("|")})\\b`, "i");

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

  // Cheapest checks first: illegal-content categories.
  if (CSAM_RE.test(text)) return blocked("sexual content involving minors is prohibited");
  if (TERROR_RE.test(text)) return blocked("terrorist content is prohibited");
  if (SLUR_RE.test(text)) return blocked("hate speech is prohibited");
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

  // Contact info: HCS content is immutable, so phone numbers and email
  // addresses are blocked here. Users can share contact details via DMs.
  if (EMAIL_RE.test(text)) {
    return blocked("posting email addresses is not allowed — share contact details via DM instead");
  }
  const phoneRe = new RegExp(PHONE_RE.source, "g");
  let pm: RegExpExecArray | null;
  while ((pm = phoneRe.exec(text)) !== null) {
    if (digitCount(pm[0]) >= 10) {
      return blocked("posting phone numbers is not allowed — share contact details via DM instead");
    }
    if (pm[0].length === 0) phoneRe.lastIndex++;
  }

  // Profanity.
  if (PROFANITY_RE.test(text)) return blocked("profanity is not allowed");

  // Link safety + link spam.
  if (DANGEROUS_SCHEME_RE.test(text)) return blocked("unsafe link schemes are not allowed");
  const urls = text.match(URL_EXTRACT_RE) ?? [];
  if (urls.length > MAX_URLS_PER_POST) {
    return blocked(`too many links (max ${MAX_URLS_PER_POST}) — looks like spam`);
  }
  for (const u of urls) {
    const checked = checkUrl(u, label);
    if (!checked.allowed) return checked;
  }

  // Spam heuristics.
  if (REPEATED_CHAR_RE.test(text)) {
    return blocked("repeated characters look like spam");
  }
  if (REPEATED_WORD_RE.test(text)) {
    return blocked("repeated words look like spam");
  }
  if (isAllCapsSpam(text)) {
    return blocked("excessive ALL CAPS looks like spam");
  }
  return { allowed: true };
}

/**
 * ALL-CAPS detection: text with 20+ letters where >70% are uppercase
 * reads as shouting/spam. Short messages and normal mixed-case pass.
 */
function isAllCapsSpam(text: string): boolean {
  let letters = 0;
  let upper = 0;
  for (const c of text) {
    if (c >= "a" && c <= "z") letters++;
    else if (c >= "A" && c <= "Z") { letters++; upper++; }
  }
  return letters >= 20 && upper / letters > 0.7;
}
