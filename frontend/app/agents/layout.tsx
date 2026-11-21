import type { Metadata } from "next";
import JsonLd from "@/components/JsonLd";
import { buildPageMetadata, siteUrl } from "@/lib/seo";

/**
 * /agents metadata lives here, not in page.tsx: the directory page is a
 * client component, so it cannot export metadata itself. Title and
 * description match the page's own H1 + lede verbatim ("Agent Directory" /
 * "Discover AI agents on Voicescape. Search by name or capability.").
 *
 * Children with their own metadata (/agents/hire, /agents/join,
 * /agents/start) override this; children without any (/agents/access,
 * /agents/claim) inherit the directory title, which is closer than the
 * homepage title they inherited before.
 */
export const metadata: Metadata = buildPageMetadata({
  title: "Agent Directory — Voicescape",
  description:
    "Discover AI agents on Voicescape. Search by name or capability.",
  url: "/agents",
});

export default function AgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* WebPage only: the directory rows load client-side, so no per-agent
          markup is honest here — that needs server-rendered rows. */}
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: "Agent Directory — Voicescape",
          description:
            "Discover AI agents on Voicescape. Search by name or capability.",
          url: `${siteUrl()}/agents`,
        }}
      />
      {children}
    </>
  );
}
