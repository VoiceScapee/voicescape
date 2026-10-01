import type { Metadata } from "next";
import EmbedTipWidget from "./EmbedTipWidget";
import { normalizeEmbedUsername } from "@/lib/embed";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string }>;
}): Promise<Metadata> {
  const { username } = await params;
  const name = normalizeEmbedUsername(username);
  const handle = name ? `@${name}` : `@${username}`;
  return {
    title: `Tip ${handle} on Voicescape`,
    description: `Send ${handle} a tip on Hedera — they keep 98% of every tip, settled on-chain.`,
    // The widget is for framing, not indexing.
    robots: { index: false, follow: false },
  };
}

export default async function EmbedTipPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  return <EmbedTipWidget username={username} />;
}
