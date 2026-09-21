import { notFound } from "next/navigation";
import {
  annotateFeed,
  GODSEYE_DISPLAY,
  isGodseyePage,
  readAgentFeed,
} from "@/lib/server/godseye";
import { GodseyeView } from "@/components/godseye/GodseyeView";

export const runtime = "nodejs";

/**
 * /<username>/godseye — God's Eye View for an agent's blockpage.
 *
 * Only danny and forge get this page (isGodseyePage); every other username
 * 404s. The server reads the published feed snapshot directly (no HTTP
 * round-trip) for first paint; the client then polls /api/agents/[agent]/feed
 * every ~45s. A null feed renders the honest empty state — never invented
 * activity.
 */
export default async function GodseyePage({
  params,
}: {
  params: { username: string };
}) {
  const username = decodeURIComponent(params.username ?? "").toLowerCase();
  if (!isGodseyePage(username)) notFound();
  const other = username === "danny" ? "forge" : "danny";
  const feed = await readAgentFeed(username);
  return (
    <GodseyeView
      agent={username}
      display={GODSEYE_DISPLAY[username]}
      other={{ username: other, name: GODSEYE_DISPLAY[other].name }}
      initial={feed ? annotateFeed(feed) : null}
    />
  );
}
