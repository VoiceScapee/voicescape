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
  { path: "/new-to-web3", changeFrequency: "monthly", priority: 0.7 },
  { path: "/mcp", changeFrequency: "monthly", priority: 0.5 },
  { path: "/mining-depin", changeFrequency: "monthly", priority: 0.7 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
];

/** Max public profile URLs in the sitemap — keeps the file small. */
export const SITEMAP_MAX_USERNAMES = 100;

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
 * Registered blockpage usernames, in first-registration order, from the
 * on-chain Registry (mirror-node registerPage calldata replay). Never
 * throws — returns [] when the registry is unconfigured, the mirror node
 * is down, or the scan is slow (>15s), so sitemap generation always
 * succeeds with the static routes alone.
 */
export async function sitemapUsernames(limit = SITEMAP_MAX_USERNAMES): Promise<string[]> {
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
    const out: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const username = row.username;
      if (
        typeof username !== "string" ||
        username.length === 0 ||
        reserved.has(username.toLowerCase()) ||
        seen.has(username)
      ) {
        continue;
      }
      seen.add(username);
      out.push(username);
      if (out.length >= Math.max(0, limit)) break;
    }
    return out;
  } catch {
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteUrl();
  const lastModified = new Date();
  const entries: MetadataRoute.Sitemap = SITEMAP_STATIC_ROUTES.map((r) => ({
    url: `${origin}${r.path}`,
    lastModified,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));
  for (const username of await sitemapUsernames()) {
    entries.push({
      url: `${origin}/${encodeURIComponent(username)}`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.6,
    });
  }
  return entries;
}
