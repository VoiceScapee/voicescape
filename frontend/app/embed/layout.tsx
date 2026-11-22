import type { Metadata } from "next";
import JsonLd from "@/components/JsonLd";
import { buildBreadcrumbJsonLd, buildPageMetadata } from "@/lib/seo";

/**
 * /embed metadata lives here, not in page.tsx: the page is a client
 * component, so it cannot export metadata itself. Title and description
 * match the page's own H1 + lede verbatim ("Get your tip button" / "Put a
 * tip button on your own website, blog, or link-in-bio page. …").
 */
export const metadata: Metadata = buildPageMetadata({
  title: "Get your tip button — Voicescape",
  description:
    "Put a tip button on your own website, blog, or link-in-bio page. Visitors tip you without leaving your site — every tip settles on Hedera and you keep 98% of it, sent straight to your wallet.",
  url: "/embed",
});

export default function EmbedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <JsonLd
        data={buildBreadcrumbJsonLd([
          { name: "Home", url: "/" },
          { name: "Get your tip button", url: "/embed" },
        ])}
      />
      {children}
    </>
  );
}
