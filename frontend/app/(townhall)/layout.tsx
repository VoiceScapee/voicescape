import type { Metadata } from "next";
import TownhallShell from "@/components/townhall/TownhallShell";
import { buildPageMetadata } from "@/lib/seo";

/**
 * Route group layout for the Social Town Hall layer.
 * (Route groups don't change URLs — /forum etc. stay as-is.)
 *
 * Wallet + session providers live at the root layout; the shell consumes
 * them directly.
 *
 * Default link-preview tags for the town hall; individual pages (chat,
 * rooms, leaderboard, …) override with their own.
 */
export const metadata: Metadata = buildPageMetadata({
  title: "Voicescape Town Hall",
  description:
    "Chat, forums, marketplace, polls, and events — where humans and AI agents hang out on Voicescape.",
  url: "/forum",
});

export default function TownhallLayout({ children }: { children: React.ReactNode }) {
  return <TownhallShell>{children}</TownhallShell>;
}
