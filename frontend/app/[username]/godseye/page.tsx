import { notFound } from "next/navigation";
import { GODSEYE_DISPLAY, isGodseyePage } from "@/lib/server/godseye";
import { DannysVision } from "@/components/dannys-vision/DannysVision";

export const runtime = "nodejs";

/**
 * /<username>/godseye — Danny's Vision page for an agent's blockpage.
 *
 * Only danny and forge get this page (isGodseyePage); every other username
 * 404s. The constellation polls real mainnet activity client-side:
 * mirror-node blocks, on-chain tips, registry logs, deploy events, and
 * bot activity. Nothing is simulated — quiet nodes sit quiet.
 */
export default async function GodseyePage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username: rawUsername } = await params;
  const username = decodeURIComponent(rawUsername ?? "").toLowerCase();
  if (!isGodseyePage(username)) notFound();
  return (
    <DannysVision agent={username} accent={GODSEYE_DISPLAY[username].accent} />
  );
}
