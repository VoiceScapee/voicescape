/**
 * robots.txt: welcome crawlers on every public page, keep them out of
 * private/operational surfaces (/api/*, /mod, /analytics), and point them
 * at the sitemap. One exception: /api/mcp answers plain GETs with a
 * machine-readable "this is an MCP endpoint, here's how to connect"
 * pointer, so fetch tools are allowed there instead of hitting a
 * ROBOTS_DISALLOWED wall.
 */
import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  const origin = siteUrl();
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/api/mcp"],
        disallow: ["/api/", "/mod", "/analytics"],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
