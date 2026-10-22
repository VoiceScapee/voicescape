/**
 * AI crawler tracker — pure matching + key building.
 *
 * Edge-safe by construction: no imports, no I/O, no Node APIs. The
 * middleware and the stats route both build on these helpers so the
 * matching rules and the key layout can never drift apart.
 *
 * What this tracker records — and ONLY this:
 *   (a) any request whose User-Agent matches a known AI crawler/bot, and
 *   (b) any request for a machine-readable file, whatever the User-Agent.
 * Human page views are the existing client-side analytics' job; this
 * tracker never records them, and it never stores IPs, raw User-Agent
 * strings, cookies, or anything identifying a human.
 */

/** Known AI crawler/bot User-Agent substrings. Canonical name = the entry. */
export const BOT_PATTERNS: readonly string[] = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot",
  "Applebot-Extended",
  "CCBot",
  "cohere-ai",
  "Meta-ExternalAgent",
  "Meta-ExternalFetcher",
  "FacebookBot",
  "Bytespider",
  "YouBot",
  "DuckAssistBot",
  "Amazonbot",
];

/** Bucket for machine-readable requests with no recognized bot UA. */
export const UNKNOWN_AGENT = "unknown-agent";

/** Longest pattern first, so "Applebot-Extended" wins over "Applebot". */
const SORTED_PATTERNS: readonly string[] = [...BOT_PATTERNS].sort(
  (a, b) => b.length - a.length,
);

/**
 * Canonical bot name for a User-Agent, or null when it matches no known
 * AI crawler. Case-insensitive substring match; the raw UA is never kept.
 */
export function matchBot(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  for (const pattern of SORTED_PATTERNS) {
    if (ua.includes(pattern.toLowerCase())) return pattern;
  }
  return null;
}

/** Exact machine-readable paths, recorded for any User-Agent. */
export const MACHINE_READABLE_PATHS: readonly string[] = [
  "/.well-known/agent-card.json",
  "/agent.json",
  "/llms.txt",
  "/robots.txt",
  "/sitemap.xml",
];

/** Prefix machine-readable paths: the path itself and everything under it. */
const MACHINE_READABLE_PREFIXES: readonly string[] = ["/api/agents", "/api/mcp"];

export function isMachineReadablePath(pathname: string): boolean {
  if (MACHINE_READABLE_PATHS.includes(pathname)) return true;
  return MACHINE_READABLE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

/**
 * Static-asset paths: never recorded, even for a bot UA (a bot fetching a
 * JS chunk or an image is not "checking Voicescape"). Machine-readable
 * paths are NOT assets even though some end in .txt/.xml — shouldRecord
 * checks them first, so they are never swallowed by this rule.
 */
export function isStaticAssetPath(pathname: string): boolean {
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico") return true;
  return /\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff|woff2|ttf|otf|map|mp3|mp4|pdf|zip|avif)$/i.test(
    pathname,
  );
}

export interface CrawlerSignal {
  bot: string;
  path: string;
}

/**
 * Decide whether a request is an AI-system signal. Returns the canonical
 * bot name + path, or null to skip. Order matters:
 *   1. the tracker's own stats endpoint is never recorded (feedback loop);
 *   2. framework internals are never recorded;
 *   3. machine-readable paths always record (bot or "unknown-agent");
 *   4. static assets never record, even for bots;
 *   5. anything else records only for a recognized bot UA.
 */
export function shouldRecord(
  userAgent: string | null | undefined,
  pathname: string,
): CrawlerSignal | null {
  if (pathname === "/api/crawlers" || pathname.startsWith("/api/crawlers/")) {
    return null;
  }
  if (pathname.startsWith("/_next/") || pathname === "/favicon.ico") {
    return null;
  }
  const bot = matchBot(userAgent);
  if (isMachineReadablePath(pathname)) {
    return { bot: bot ?? UNKNOWN_AGENT, path: pathname };
  }
  if (isStaticAssetPath(pathname)) return null;
  if (bot) return { bot, path: pathname };
  return null;
}

/** UTC day key, YYYY-MM-DD. */
export function dayKey(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Daily counters live 30 days (same window as the existing analytics). */
export const CRAWLER_COUNTER_TTL_MS = 30 * 24 * 3600 * 1000;
/** First/last-seen + path index live a year (cheap, and the report window is a week). */
export const CRAWLER_META_TTL_MS = 365 * 24 * 3600 * 1000;
/** Global index of every path ever recorded (JSON array, capped). */
export const CRAWLER_PATHS_INDEX_KEY = "crawler:v1:paths";
export const CRAWLER_PATHS_INDEX_CAP = 1000;

/**
 * Paths are capped and control-stripped before keying. Written as a
 * char-code loop (not a regex) so no control bytes ever land in source.
 */
export function sanitizePath(pathname: string): string {
  const capped = pathname.slice(0, 200);
  let out = "";
  for (const ch of capped) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? "_" : ch;
  }
  return out;
}

export function botDayKey(day: string, bot: string): string {
  return `crawler:v1:day:${day}:bot:${bot}`;
}

export function pathDayKey(day: string, path: string): string {
  return `crawler:v1:day:${day}:path:${encodeURIComponent(path)}`;
}

export function botFirstKey(bot: string): string {
  return `crawler:v1:bot:${bot}:first`;
}

export function botLastKey(bot: string): string {
  return `crawler:v1:bot:${bot}:last`;
}

export function decodePathKey(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}
