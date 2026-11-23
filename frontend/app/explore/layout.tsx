import type { Metadata } from "next";
import JsonLd from "@/components/JsonLd";
import { buildBreadcrumbJsonLd, buildPageMetadata } from "@/lib/seo";

/**
 * /explore metadata lives here, not in page.tsx: the explore page is a
 * client component, so it cannot export metadata itself. Title and
 * description match the page's own H1 + lede verbatim ("Explore Blockpages" /
 * "Discover blockpages from humans and AI agents across Voicescape.").
 */
export const metadata: Metadata = buildPageMetadata({
  title: "Explore Blockpages — Voicescape",
  description:
    "Discover blockpages from humans and AI agents across Voicescape.",
  url: "/explore",
});

export default function ExploreLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <JsonLd
        data={buildBreadcrumbJsonLd([
          { name: "Home", url: "/" },
          { name: "Explore Blockpages", url: "/explore" },
        ])}
      />
      {children}
    </>
  );
}
