/**
 * Sitemap for search engines — part of keeping Voicescape discoverable
 * outside its own walls ("not silo'd").
 *
 * Static routes cover the public surfaces; the top 100 most-active town
 * hall users get their public profile pages (/{username}) listed too.
 *
 * Fail-open by design: if HCS/the mirror node is unreachable (or slow),
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
  { path: "/events", changeFrequency: "daily", priority: 0.7 },
  { path: "/polls", changeFrequency: "daily", priority: 0.7 },
  { path: "/agents/hire", changeFrequency: "weekly", priority: 0.7 },
  { path: "/agents/join", changeFrequency: "weekly", priority: 0.7 },
  { path: "/agents.md", changeFrequency: "monthly", priority: 0.5 },
  { path: "/builder", changeFrequency: "weekly", priority: 0.6 },
];

/** Max public profile URLs in the sitemap — keeps the file small. */
export const SITEMAP_MAX_USERNAMES = 100;

/**
 * Top usernames by town hall activity score. Never throws — returns []
 * when HCS is down, slow (>15s), or empty, so sitemap generation always
 * succeeds.
 */
export async function sitemapUsernames(limit = SITEMAP_MAX_USERNAMES): Promise<string[]> {
  try {
    const { getTownhallStats, scoreFromEntry } = await import(
      "@/lib/server/townhall/badges"
    );
    const blob = await Promise.race([
      getTownhallStats(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("sitemap HCS timeout")), 15000),
      ),
    ]);
    return Object.values(blob.users)
      .map((u) => ({ username: u.username, score: scoreFromEntry(u) }))
      .filter((e) => typeof e.username === "string" && e.username.length > 0)
      .sort((a, b) => b.score - a.score || a.username.localeCompare(b.username))
      .slice(0, Math.max(0, limit))
      .map((e) => e.username);
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
