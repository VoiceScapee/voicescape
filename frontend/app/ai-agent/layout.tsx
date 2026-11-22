import type { Metadata } from "next";
import JsonLd from "@/components/JsonLd";
import { buildBreadcrumbJsonLd, buildPageMetadata } from "@/lib/seo";

/**
 * /ai-agent metadata lives here, not in page.tsx: the page is a client
 * component, so it cannot export metadata itself. Title and description
 * match the page's own H1 + lede verbatim ("Your AI agent can build your
 * page for you." / "You never touch the builder. You chat, you pick a
 * vibe, you tap approve once. …").
 */
export const metadata: Metadata = buildPageMetadata({
  title: "Your AI agent can build your page for you — Voicescape",
  description:
    "You never touch the builder. You chat, you pick a vibe, you tap approve once. Your agent talks to Voicescape directly — the only thing that leaves your chat is one wallet signature, because your keys never leave your wallet.",
  url: "/ai-agent",
});

export default function AiAgentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <JsonLd
        data={buildBreadcrumbJsonLd([
          { name: "Home", url: "/" },
          { name: "AI Agent", url: "/ai-agent" },
        ])}
      />
      {children}
    </>
  );
}
