/**
 * Voicescape Town Hall — cross-domain activity feed ("what's happening").
 *
 * Reads the latest few messages from each HCS topic via the mirror node
 * and formats them as a single newest-first list for the "live" ticker.
 * Pure aggregation over `deps.hcs.query` — unit-testable, no new infra.
 */

import { getTopicId } from "./topics";
import type {
  ChatMessage,
  ListingMessage,
  PostMessage,
  ProposalMessage,
  ProposalVoteMessage,
} from "./types";
import type { TownhallDeps } from "./handlers";

export interface ActivityItem {
  kind: "post" | "chat" | "proposal" | "vote" | "listing";
  /** Short human-readable summary. */
  text: string;
  author: string;
  /** ISO-8601. */
  ts: string;
  /** Deep link. */
  href: string;
}

const PER_TOPIC = 6;
const MAX_ITEMS = 12;

function clip(s: string, n = 70): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function safeHrefPart(s: string): string {
  return encodeURIComponent(s);
}

/**
 * Latest activity across forum, chat, polls, and marketplace.
 * Each topic read is independent — one slow topic can't kill the feed.
 */
export async function getActivity(deps: TownhallDeps): Promise<ActivityItem[]> {
  const items: ActivityItem[] = [];

  const forumTopic = getTopicId("forum");
  if (forumTopic) {
    try {
      const msgs = await deps.hcs.query(forumTopic, { limit: PER_TOPIC });
      for (const m of msgs) {
        if (m.contents.kind !== "post") continue;
        const c = m.contents as PostMessage;
        items.push({
          kind: "post",
          text: clip(c.body),
          author: c.author,
          ts: c.ts,
          href: `/forum/${safeHrefPart(c.board)}`,
        });
      }
    } catch {
      /* one topic down — the feed continues */
    }
  }

  const chatTopic = getTopicId("chat");
  if (chatTopic) {
    try {
      const msgs = await deps.hcs.query(chatTopic, { limit: PER_TOPIC });
      for (const m of msgs) {
        if (m.contents.kind !== "chat") continue;
        const c = m.contents as ChatMessage;
        items.push({
          kind: "chat",
          text: clip(c.body),
          author: c.author,
          ts: c.ts,
          href: `/chat/${safeHrefPart(c.room)}`,
        });
      }
    } catch {
      /* feed continues */
    }
  }

  const govTopic = getTopicId("governance");
  if (govTopic) {
    try {
      const msgs = await deps.hcs.query(govTopic, { limit: PER_TOPIC });
      for (const m of msgs) {
        if (m.contents.kind === "proposal") {
          const c = m.contents as ProposalMessage;
          items.push({
            kind: "proposal",
            text: `opened poll: ${clip(c.title, 50)}`,
            author: c.author,
            ts: c.ts,
            href: "/polls",
          });
        } else if (m.contents.kind === "proposal-vote") {
          const c = m.contents as ProposalVoteMessage;
          items.push({
            kind: "vote",
            text: `voted ${c.choice}`,
            author: c.voter,
            ts: c.ts,
            href: "/polls",
          });
        }
      }
    } catch {
      /* feed continues */
    }
  }

  const marketTopic = getTopicId("market");
  if (marketTopic) {
    try {
      const msgs = await deps.hcs.query(marketTopic, { limit: PER_TOPIC });
      for (const m of msgs) {
        if (m.contents.kind !== "listing") continue;
        const c = m.contents as ListingMessage;
        const who = c.sellerUsername ?? c.seller;
        items.push({
          kind: "listing",
          text: c.status === "active" ? `listed: ${clip(c.title, 50)}` : `updated: ${clip(c.title, 50)}`,
          author: who,
          ts: c.ts,
          href: `/marketplace/${safeHrefPart(c.id)}`,
        });
      }
    } catch {
      /* feed continues */
    }
  }

  return items
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, MAX_ITEMS);
}
