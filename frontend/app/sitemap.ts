/**
 * Sitemap for search engines — part of keeping Voicescape discoverable
 * outside its own walls ("not silo'd").
 *
 * Static routes cover the public surfaces; registered blockpages
 * (/{username}) come from the AUTHORITATIVE source — the on-chain
 * Registry, replayed from the mirror node's registerPage calldata feed
 * (scanRegisteredUsernames). Town-hall activity used to be the proxy
 * here; it is not the registry, so it no longer decides what is listed.
 *
 * Fail-open by design: if the mirror node is unreachable (or slow),
 * the sitemap still serves every static route with zero usernames rather
 * than breaking the build or the /sitemap.xml request.
 */
import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

export const revalidate = 3600; // refresh hourly
export const runtime = "nodejs";

interface StaticRoute {
  path: string;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
  priority: number;
}

export const SITEMAP_STATIC_ROUTES: StaticRoute[] = [
  { path: "/", changeFrequency: "daily", priority: 1.0 },
  { path: "/forum", changeFrequency: "hourly", priority: 0.8 },
  { path: "/chat", changeFrequency: "hourly", priority: 0.8 },
  { path: "/marketplace", changeFrequency: "hourly", priority: 0.8 },
  { path: "/leaderboard", changeFrequency: "daily", priority: 0.7 },
  { path: "/fundraiser", changeFrequency: "daily", priority: 0.7 },
  { path: "/events", changeFrequency: "daily", priority: 0.7 },
  { path: "/polls", changeFrequency: "daily", priority: 0.7 },
  { path: "/agents", changeFrequency: "weekly", priority: 0.8 },
  { path: "/agents/hire", changeFrequency: "weekly", priority: 0.7 },
  { path: "/agents/join", changeFrequency: "weekly", priority: 0.7 },
  { path: "/intros", changeFrequency: "weekly", priority: 0.7 },
  { path: "/ai-agent", changeFrequency: "monthly", priority: 0.7 },
  { path: "/explore", changeFrequency: "daily", priority: 0.8 },
  { path: "/console", changeFrequency: "weekly", priority: 0.6 },
  { path: "/agents.md", changeFrequency: "monthly", priority: 0.5 },
  { path: "/builder", changeFrequency: "weekly", priority: 0.6 },
  { path: "/embed", changeFrequency: "monthly", priority: 0.6 },
  { path: "/new-to-web3", changeFrequency: "monthly", priority: 0.7 },
  { path: "/trust", changeFrequency: "monthly", priority: 0.7 },
  { path: "/mcp", changeFrequency: "monthly", priority: 0.5 },
  { path: "/mining-depin", changeFrequency: "monthly", priority: 0.7 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
];

/** Max public profile URLs in the sitemap — keeps the file small. */
export const SITEMAP_MAX_USERNAMES = 100;

/**
 * Registered usernames that must never be offered to crawlers: test/debug
 * pages that serve only the empty resolver shell. They stay reachable by
 * direct URL (they are real on-chain registrations) — they are just not
 * advertised in the sitemap.
 */
export const SITEMAP_EXCLUDED_USERNAMES = new Set([
  "danny-debug-1",
  "human-test-0913",
]);

/**
 * First segments a registered username must NOT equal: static routes win
 * over the [username] route in Next.js, so a registered name like
 * "agents" or "forum" is not that user's page URL and must not be listed
 * as one. Operational surfaces are excluded for the same reason.
 */
export function sitemapReservedFirstSegments(): Set<string> {
  const reserved = new Set<string>(["api", "mod", "analytics", "admin"]);
  for (const r of SITEMAP_STATIC_ROUTES) {
    const first = r.path.split("/")[1];
    if (first) reserved.add(first);
  }
  return reserved;
}

/**
 * Mirror-node contract-result timestamps are epoch seconds with a
 * nanosecond fraction ("1791394487.884407081"), NOT ISO dates. Sitemap
 * lastmod requires a W3C/ISO-8601 date — convert, and return null for
 * anything unparseable so no bad lastmod is ever emitted.
 */
export function mirrorTimestampToIso(ts: string | null): string | null {
  if (!ts) return null;
  const secs = Number(ts);
  if (Number.isFinite(secs)) {
    // Numeric input is an epoch-seconds timestamp (or invalid when <= 0).
    // Never let it fall through to Date.parse: V8 reads "0" as a year.
    if (secs <= 0) return null;
    const d = new Date(secs * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Tolerate an already-ISO timestamp (defensive — the mirror node emits
  // epoch seconds, but never emit a bad lastmod for a parsable date).
  const parsed = new Date(ts);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Registered blockpage usernames, in first-registration order, from the
 * on-chain Registry (mirror-node registerPage calldata replay), WITH the
 * mirror-node timestamp of each registerPage call. Never throws — returns
 * [] when the registry is unconfigured, the mirror node is down, or the
 * scan is slow (>15s), so sitemap generation always succeeds with the
 * static routes alone.
 *
 * Filtered the same way everywhere: reserved first segments (a registered
 * name like "agents" is not that user's page URL), the excluded test/debug
 * names, and duplicates.
 */
export async function sitemapUsernameRows(
  limit = SITEMAP_MAX_USERNAMES,
): Promise<{ username: string; registeredAt: string | null }[]> {
  try {
    const [{ scanRegisteredUsernames }, { getRegistryAddress }] =
      await Promise.all([
        import("@/lib/server/agents-directory"),
        import("@/lib/contracts"),
      ]);
    const registry = getRegistryAddress();
    if (!registry) return [];
    const rows = await Promise.race([
      scanRegisteredUsernames(registry),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("sitemap registry timeout")), 15000),
      ),
    ]);
    const reserved = sitemapReservedFirstSegments();
    const out: { username: string; registeredAt: string | null }[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const username = row.username;
      if (
        typeof username !== "string" ||
        username.length === 0 ||
        reserved.has(username.toLowerCase()) ||
        SITEMAP_EXCLUDED_USERNAMES.has(username.toLowerCase()) ||
        seen.has(username)
      ) {
        continue;
      }
      seen.add(username);
      out.push({
        username,
        // Normalize the mirror epoch timestamp to ISO-8601 here, at the
        // single source, so lastmod is always a valid W3C date.
        registeredAt: mirrorTimestampToIso(row.registeredAt ?? null),
      });
      if (out.length >= Math.max(0, limit)) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Registered blockpage usernames, in first-registration order. Same
 * source and filtering as sitemapUsernameRows, names only.
 */
export async function sitemapUsernames(limit = SITEMAP_MAX_USERNAMES): Promise<string[]> {
  return (await sitemapUsernameRows(limit)).map((r) => r.username);
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteUrl();
  // Static routes carry NO lastmod: no per-page change date exists at
  // runtime, and stamping every URL with one shared build timestamp
  // would tell crawlers every page changed at once. changeFrequency
  // still signals freshness; crawlers re-fetch to detect real changes.
  const entries: MetadataRoute.Sitemap = SITEMAP_STATIC_ROUTES.map((r) => ({
    url: `${origin}${r.path}`,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));
  for (const { username, registeredAt } of await sitemapUsernameRows()) {
    entries.push({
      url: `${origin}/${encodeURIComponent(username)}`,
      // Real per-page date: the mirror-node timestamp of the registerPage
      // call. Null when the scan could not provide one — then no lastmod
      // rather than a made-up one.
      ...(registeredAt ? { lastModified: registeredAt } : {}),
      changeFrequency: "weekly",
      priority: 0.6,
    });
  }
  return entries;
}
