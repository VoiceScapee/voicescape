/**
 * Curated official Hedera video clips for the community pulse.
 *
 * Brandon asked for video clips, not just articles. The official Hedera
 * YouTube channel feed needs a confirmed channel_id (still unverified —
 * do NOT guess it), so this is an honest curated set instead of a fake
 * auto-updating feed: five real videos from the official @hederahashgraph
 * channel, titles verified live on 2026-09-13.
 *
 * To refresh the set, replace entries with newly verified official URLs.
 * Thumbnails use YouTube's official thumbnail CDN (i.ytimg.com).
 */
import type { PulseItem } from "@/lib/server/rss";

const thumb = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

export const CURATED_VIDEOS: PulseItem[] = [
  {
    title: "AI Meets DLT: Navigating a New Era | Hedera Forum Miami",
    url: "https://www.youtube.com/watch?v=PNf8TKXqXwU",
    date: "",
    source: "Hedera YouTube",
    kind: "video",
    thumb: thumb("PNf8TKXqXwU"),
  },
  {
    title: "The Hedera Roadmap to True Interoperability | HederaCon 2026",
    url: "https://www.youtube.com/watch?v=F5uEYJL1ups",
    date: "",
    source: "Hedera YouTube",
    kind: "video",
    thumb: thumb("F5uEYJL1ups"),
  },
  {
    title: "Trust on Chain: The Tokenization Era Takes Hold | HederaCon 2026",
    url: "https://www.youtube.com/watch?v=PpQF4U9L_OE",
    date: "",
    source: "Hedera YouTube",
    kind: "video",
    thumb: thumb("PpQF4U9L_OE"),
  },
  {
    title: "Hedera AI Agent Kit | Open-Source Toolkit for Building AI Agents on Hedera",
    url: "https://www.youtube.com/watch?v=iGxQijt8pco",
    date: "",
    source: "Hedera YouTube",
    kind: "video",
    thumb: thumb("iGxQijt8pco"),
  },
  {
    title: "Hedera: Building the Trust Layer of the Digital World",
    url: "https://www.youtube.com/watch?v=DGD1LjZdZvM",
    date: "",
    source: "Hedera YouTube",
    kind: "video",
    thumb: thumb("DGD1LjZdZvM"),
  },
];
