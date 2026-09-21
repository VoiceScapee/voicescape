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
    if (!isValidFeedShape(feed) || feed.agent !== agent) {
      return null;
    }
    return feed;
  } catch {
    return null;
  }
}

/**
 * Public gist holding the live feed snapshots. The deployed bundle can't be
 * rewritten, so the VM collector publishes here every ~5 min and the dapp
 * reads live from it; the bundled file above is only the fallback. The gist
 * is public — the feed is public data by design (the collector is the
 * privacy firewall; this reader only ever serves what it was given).
 */
const GODSEYE_GIST_ID = "b588cd71644df34755ac75af42515d27";
const GODSEYE_GIST_RAW = (agent: GodseyeAgent) =>
  `https://gist.github.com/VoiceScapee/${GODSEYE_GIST_ID}/raw/${agent}.json`;

/** Shape check for anything fetched off the network — never trust it blindly. */
export function isValidFeedShape(u: unknown): u is GodseyeFeed {
  if (!u || typeof u !== "object") return false;
  const f = u as Record<string, unknown>;
  return (
    typeof f["generatedAt"] === "string" &&
    typeof f["agent"] === "string" &&
    Array.isArray(f["events"]) &&
    Array.isArray(f["systems"]) &&
    Array.isArray(f["queue"])
  );
}

async function readRemoteFeed(agent: GodseyeAgent): Promise<GodseyeFeed | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(GODSEYE_GIST_RAW(agent), {
      cache: "no-store",
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const feed: unknown = await r.json();
    if (!isValidFeedShape(feed) || feed.agent !== agent) return null;
    return feed;
  } catch {
    return null;
  }
}

/**
 * Live-first feed reader: the gist (refreshed ~5 min by the collector), then
 * the bundled snapshot as fallback. Used by both the API route and the
 * server page so first paint is fresh too.
 */
export async function readLiveFeed(agent: GodseyeAgent): Promise<GodseyeFeed | null> {
  return (await readRemoteFeed(agent)) ?? (await readAgentFeed(agent));
}

export function annotateFeed(feed: GodseyeFeed, nowMs = Date.now()): AnnotatedFeed {
  const gen = Date.parse(feed.generatedAt);
  const updatedAgoSec = Number.isFinite(gen)
    ? Math.max(0, Math.floor((nowMs - gen) / 1000))
    : Number.POSITIVE_INFINITY;
  return { ...feed, updatedAgoSec, stale: updatedAgoSec > GODSEYE_STALE_AFTER_SEC };
}
