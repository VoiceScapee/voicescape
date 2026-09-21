import { promises as fs } from "fs";
import path from "path";

/**
 * God's Eye View feed reader (server-only).
 *
 * The public feed is a static JSON snapshot written by the VM collector
 * (ops/godseye/collector.py). The privacy firewall lives in the collector:
 * this module only reads what the collector published, computes staleness
 * (the dead-man's switch behind the LIVE badge), and never invents events.
 */

export const GODSEYE_AGENTS = ["danny", "forge"] as const;
export type GodseyeAgent = (typeof GODSEYE_AGENTS)[number];

/** Seconds after which the feed is considered stale (LIVE badge flips). */
export const GODSEYE_STALE_AFTER_SEC = 600;

export interface GodseyeEvent {
  id: string;
  ts: string;
  sys: string;
  type: string;
  summary: string;
  proof: string | null;
}

export interface GodseyeFeed {
  v: number;
  agent: string;
  generatedAt: string;
  systems: { id: string; wired: boolean }[];
  now: { focus: string } | null;
  events: GodseyeEvent[];
  queue: { label: string; waitingOnOwner: boolean }[];
}

export interface AnnotatedFeed extends GodseyeFeed {
  updatedAgoSec: number;
  stale: boolean;
}

export function isGodseyeAgent(a: string): a is GodseyeAgent {
  return (GODSEYE_AGENTS as readonly string[]).includes(a);
}

/**
 * Display identity per agent (Brandon's naming, 2026-09-20):
 * Danny's page reads "Voicescape Dapp Engine"; Forge's subtitle reads
 * "Blockpage Buddy / Forge Builder". Only these two agents get a
 * /<username>/godseye page — everyone else 404s.
 */
export const GODSEYE_DISPLAY: Record<
  GodseyeAgent,
  { name: string; subtitle: string; role: string; accent: string }
> = {
  danny: {
    name: "Voicescape Dapp Engine",
    subtitle: "God's Eye View",
    role: "AI AGENT · OPERATOR",
    accent: "#2dd4bf",
  },
  forge: {
    name: "Forge",
    subtitle: "Blockpage Buddy / Forge Builder",
    role: "AI AGENT · BUILDER SERVICE",
    accent: "#fb923c",
  },
};

/** Blockpage usernames that get a /godseye sub-page. */
export function isGodseyePage(username: string): username is GodseyeAgent {
  return isGodseyeAgent(username.toLowerCase());
}

export async function readAgentFeed(agent: GodseyeAgent): Promise<GodseyeFeed | null> {
  const p = path.join(process.cwd(), "data", "feeds", `${agent}.json`);
  try {
    const raw = await fs.readFile(p, "utf8");
    const feed = JSON.parse(raw) as GodseyeFeed;
    if (!feed || typeof feed.generatedAt !== "string" || !Array.isArray(feed.events)) {
      return null;
    }
    return feed;
  } catch {
    return null;
  }
}

export function annotateFeed(feed: GodseyeFeed, nowMs = Date.now()): AnnotatedFeed {
  const gen = Date.parse(feed.generatedAt);
  const updatedAgoSec = Number.isFinite(gen)
    ? Math.max(0, Math.floor((nowMs - gen) / 1000))
    : Number.POSITIVE_INFINITY;
  return { ...feed, updatedAgoSec, stale: updatedAgoSec > GODSEYE_STALE_AFTER_SEC };
}
