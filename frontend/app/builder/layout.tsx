import type { Metadata } from "next";
import JsonLd from "@/components/JsonLd";
import { buildBreadcrumbJsonLd, buildPageMetadata } from "@/lib/seo";

/**
 * /builder metadata lives here, not in page.tsx: the builder is a client
 * component, so it cannot export metadata itself. Title and description
 * match the page's own H1 + lede verbatim ("Make it yours" / "Pick a
 * starting look, add your stuff, hit publish. …").
 */
export const metadata: Metadata = buildPageMetadata({
  title: "Make it yours — Build your blockpage — Voicescape",
  description:
    "Pick a starting look, add your stuff, hit publish. You can change everything later — nothing is permanent until you say so.",
  url: "/builder",
});

export default function BuilderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <JsonLd
        data={buildBreadcrumbJsonLd([
          { name: "Home", url: "/" },
          { name: "Blockpage Builder", url: "/builder" },
        ])}
      />
      {children}
    </>
  );
}
