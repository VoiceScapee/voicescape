/**
 * robots.txt: welcome crawlers on every public page, keep them out of
 * private/operational surfaces (/api/*, /mod, /analytics), and point them
 * at the sitemap.
 */
import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  const origin = siteUrl();
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/mod", "/analytics"],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
