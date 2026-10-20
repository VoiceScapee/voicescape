"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Navbar from "@/components/Navbar";
import {
  MIRROR_BLOCKS_URL,
  parseLatestBlock,
  parseBlockAnatomy,
  planBlockPulses,
  PAGE_REGISTERED_TOPIC0,
  PAGE_UPDATED_TOPIC0,
  PURCHASE_COMPLETED_TOPIC0,
  findWhaleLegs,
  decodePurchaseAmountHbar,
  hbarPriceUsd,
  formatFeedAgo,
  shortHash,
  txFinalitySeconds,
  formatFinality,
  sampleTps,
  medianFinalitySeconds,
  nodeAccountToCity,
  groupTxByCity,
  selectHeroTxs,
  type GossipTx,
} from "@/lib/network-pulse";
import "./dannys-vision.css";

/* ------------------------------------------------------------------ */
/* Nodes                                                               */
/* ------------------------------------------------------------------ */

const GOLD = "#f5c542"; // payment / tip
const TEAL = "#2dd4bf"; // ship / deploy
const GREEN = "#4ade80"; // new system online
const SKY = "#7dd3fc"; // X activity
const VIOLET = "#c4b5fd"; // Discord activity

interface NodeDef {
  id: string;
  label: string | null; // null = icon-only (X / Discord)
  color: string;
  icon?: "x" | "discord";
  quietNote?: string; // honest quiet-state line for the popup
}

const NODES: NodeDef[] = [
  { id: "voicescape", label: "VOICESCAPE", color: TEAL },
  { id: "registry", label: "REGISTRY", color: GREEN },
  { id: "tips", label: "TIPS", color: GOLD },
  { id: "x", label: null, color: SKY, icon: "x",
    quietNote: "Quiet — no posts logged yet." },
  { id: "discord", label: null, color: VIOLET, icon: "discord",
    quietNote: "Quiet — no messages logged yet." },
];

/** Consensus-city satellites: EVERY real city from the Hedera node
 *  address book, drawn as a dim outer ring so the constellation shows
 *  the network's live geography. The gossip layer lights them with
 *  real per-node transaction traffic. */
const CITY = "#99f6e0"; // consensus-city satellites
const cityId = (city: string) =>
  `city:${city.toLowerCase().replace(/\s+/g, "-")}`;

/** Gossip-layer palette: hero ripples render near-white so they read
 *  as light, distinct from every node color. */
const RIPPLE = "#f4feff";
const GOSSIP_POLL_MS = 3_000;
const GOSSIP_LIMIT = 100;
const HERO_TX_CAP = 4;
const MAX_RIPPLES = 4;
const MAX_GOSSIP_PULSES = 40;
const GOSSIP_SEEN_CAP = 2000;

/* Simplified brand marks, drawn small on canvas via Path2D. */
const X_PATH =
  "M17.5 3h3.1l-6.8 7.8L21.8 21h-6.3l-4.9-6.4L4.9 21H1.8l7.3-8.4L2.2 3h6.4l4.4 5.9 4.5-5.9z";
const DISCORD_PATH =
  "M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.2.5c1.8.4 3.2 1.1 4.6 2.3a18 18 0 0 0-15.6 0C5.6 4.6 7 3.9 8.8 3.5L8.6 3a19.8 19.8 0 0 0-4.9 1.4C.6 9.1-.3 13.7.2 18.3c2 1.5 4 2.4 5.9 3l.5-.7c-1-.4-2-.9-2.9-1.5l.7-.5c2.8 1.3 5.8 1.3 8.6 0l.7.5c-.9.6-1.9 1.1-2.9 1.5l.5.7c1.9-.6 3.9-1.5 5.9-3 .6-5.3-.5-9.9-2.9-13.9zM8.7 15.3c-1.2 0-2.1-1-2.1-2.3s.9-2.3 2.1-2.3 2.2 1 2.1 2.3c0 1.2-.9 2.3-2.1 2.3zm6.6 0c-1.2 0-2.1-1-2.1-2.3s.9-2.3 2.1-2.3 2.2 1 2.1 2.3c0 1.2-.9 2.3-2.1 2.3z";

/* ------------------------------------------------------------------ */
/* FX model — every motion comes from a real observed event            */
/* ------------------------------------------------------------------ */

interface Ping {
  nodeId: string; // node id, or "engine"
  color: string;
  t: number; // 0 → 1
}
interface Ribbon {
  nodeId: string;
  color: string;
  t: number; // 0 → 1, center → node
}
/**
 * Aggregate gossip pulse: one poll's worth of real traffic hitting a
 * consensus-city satellite. Strength is ∝ the city's tx count in the
 * window — never a decorative heartbeat.
 */
interface GossipPulse {
  cityId: string; // city:xxx
  color: string;
  t: number; // 0 → 1
  strength: number; // 0 → 1
}
/**
 * Hero ripple: a single real transaction's recorded journey. The light
 * leaves the submitting node's city and spreads — illustrating how
 * gossip carried it (the network publishes no literal paths). It
 * resolves to finalityS, the transaction's OWN finality in seconds.
 */
interface Ripple {
  cityId: string;
  color: string;
  t: number; // 0 → 1, the spreading light
  finalityS: number;
  txId: string; // mirror transaction_id
  title: string;
  sub: string;
  url: string;
  ts: number; // consensus ms
}
/** Transient "FINAL · 5.7s" label spawned where a ripple resolves. */
interface FinalLabel {
  cityId: string;
  text: string;
  t: number; // 0 → 1 fade
}
interface NodeInfo {
  headline: string; // one-line status for the popup
  lines: string[]; // popup detail lines
  links?: { label: string; url: string }[]; // verifiable proof — HashScan
  active: boolean; // seen real activity this session
}

/**
 * One row in the LIVE FEED: a real observed event — a tip, a registry
 * write, a marketplace sale, or a whale transfer — each carrying its
 * HashScan proof. Newest first, capped so the list never grows unbounded.
 */
interface FeedItem {
  id: string;
  color: string;
  title: string;
  sub: string;
  url: string;
  ts: number; // ms since epoch
}
const FEED_CAP = 15;

const TIPS_URL = "/api/activity/recent";
const REGISTRY_LOGS_URL =
  "https://mainnet.mirrornode.hedera.com/api/v1/contracts/0.0.10854058/results/logs?order=desc&limit=10";
/** Tips contract logs — marketplace PurchaseCompleted events live here. */
const TIPS_LOGS_URL =
  "https://mainnet.mirrornode.hedera.com/api/v1/contracts/0.0.10854060/results/logs?order=desc&limit=15";
const EXCHANGE_URL =
  "https://mainnet.mirrornode.hedera.com/api/v1/network/exchangerate";
const BORN_TX_URL = (type: string, hourAgoSec: number) =>
  `https://mainnet.mirrornode.hedera.com/api/v1/transactions?transactiontype=${type}&timestamp=gte:${hourAgoSec}&limit=100&order=desc`;
/** Platform treasury on Hedera mainnet — every 98/2 split settles here. */
const TREASURY_TXS_URL =
  "https://mainnet.mirrornode.hedera.com/api/v1/transactions?account.id=0.0.10424063&limit=10&order=desc";
const SOCIAL_URL = "/api/social/activity";
const BLOCK_POLL_MS = 8_000;
const SLOW_POLL_MS = 60_000;

/**
 * Fetch JSON with a hard timeout. Every poller on this page hits either our
 * own API or Hedera's public mirror node; a hung request must never outlive
 * its poll tick — overlapping polls pile up, saturate the browser's
 * connection pool (mobile in-app browsers hit this first), and the page
 * looks dead. Anything slower than the timeout is a miss: callers keep
 * their last good state and try again next tick.
 */
const FETCH_TIMEOUT_MS = 12_000;

async function fetchJson(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!r.ok) throw new Error(`http ${r.status}`);
    return (await r.json()) as unknown;
  } finally {
    clearTimeout(t);
  }
}

function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

/** Display name for icon-only nodes in popups (canvas stays icon-only). */
const NODE_TITLES: Record<string, string> = { x: "X", discord: "DISCORD" };

function ago(ts: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Mirror-node "seconds.nanoseconds" → ms, exact (no float rounding). */
function mirrorTsToMs(ts: string): number {
  const [sec, frac = ""] = ts.split(".");
  const s = Number(sec);
  if (!Number.isFinite(s)) return NaN;
  return s * 1000 + Number((frac + "000").slice(0, 3));
}

function mirrorAgo(ts: string): string {
  const ms = mirrorTsToMs(ts);
  if (!Number.isFinite(ms)) return "recently";
  return ago(new Date(ms).toISOString());
}

/** HashScan URL for a transaction. Accepts the mirror's "0.0.x-ssss-nnn"
 *  transaction_id (converted to the 0.0.x@ssss.nnn form HashScan wants) or
 *  a 0x transaction hash, which HashScan also resolves. */
function hashscanTxUrl(txHash: string): string {
  const m = txHash.match(/^(0\.0\.\d+)-(\d+)-(\d+)$/);
  const id = m ? `${m[1]}@${m[2]}.${m[3]}` : txHash;
  return `https://hashscan.io/mainnet/transaction/${id}`;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function DannysVision({
  agent,
  accent,
}: {
  agent: string;
  accent: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fx = useRef<{
    pings: Ping[];
    ribbons: Ribbon[];
    gossip: GossipPulse[];
    ripples: Ripple[];
    finals: FinalLabel[];
  }>({ pings: [], ribbons: [], gossip: [], ripples: [], finals: [] });
  const info = useRef<Record<string, NodeInfo>>({});
  const seen = useRef({
    tips: new Set<string>(),
    registry: new Set<string>(),
    voicescape: new Set<string>(),
    social: new Set<string>(),
    sales: new Set<string>(),
    whales: new Set<string>(),
    gossip: new Set<string>(),
    feedIds: new Set<string>(),
    primed: false,
  });
  const lastBlock = useRef<number | null>(null);
  const mirrorOk = useRef(true);
  /** In-flight poll keys — a tick never starts a poll that's still running. */
  const busy = useRef(new Set<string>());
  const pos = useRef<{ id: string; x: number; y: number; r: number }[]>([]);
  /** Live consensus cities (address book) + their outer-ring positions. */
  const citiesRef = useRef<string[]>([]);
  /** Node account id (0.0.x) -> consensus city, from the address book. */
  const nodeCityRef = useRef<Record<string, string>>({});
  /** City -> node account ids in that city (for popups). */
  const cityNodesRef = useRef<Record<string, string[]>>({});
  /** Exact-string mirror consensus-timestamp cursor for the gossip
   *  poller. Never parsed — float rounding would corrupt pagination. */
  const gossipCursor = useRef<string | null>(null);
  const gossipOk = useRef(true);
  const cityPos = useRef<{ id: string; x: number; y: number; r: number }[]>([]);
  const chimeDone = useRef(false);
  const [, setTick] = useState(0);
  const [popup, setPopup] = useState<string | null>(null);
  const [popupInfo, setPopupInfo] = useState<NodeInfo | null>(null);
  const [live, setLive] = useState(true);
  const [vitals, setVitals] = useState<string | null>(null);
  const [gossipLine, setGossipLine] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [bornLine, setBornLine] = useState<string | null>(null);
  const [citiesLine, setCitiesLine] = useState<string | null>(null);

  /** Merge new feed items, newest first, capped — duplicates never render. */
  const addFeed = (items: FeedItem[]) => {
    if (items.length === 0) return;
    const fresh = items.filter(
      (i) => Number.isFinite(i.ts) && !seen.current.feedIds.has(i.id),
    );
    if (fresh.length === 0) return;
    for (const i of fresh) seen.current.feedIds.add(i.id);
    setFeed((prev) =>
      [...fresh, ...prev].sort((a, b) => b.ts - a.ts).slice(0, FEED_CAP),
    );
  };

  const centerLabel = agent === "forge" ? "FORGE" : "ENGINE";

  const fire = (nodeId: string, color: string, ribbon = false) => {
    if (ribbon) fx.current.ribbons.push({ nodeId, color, t: 0 });
    else fx.current.pings.push({ nodeId, color, t: 0 });
  };

  const playChime = () => {
    if (chimeDone.current) return;
    chimeDone.current = true;
    try {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new AC();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 660;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.45);
    } catch {
      /* audio unavailable — stay silent */
    }
  };

  const openPopup = (nodeId: string) => {
    playChime();
    const def = NODES.find((n) => n.id === nodeId);
    if (!def) return;
    if (nodeId === "x" || nodeId === "discord") {
      // Icon-only nodes: pulse + a content-free status popup (counts and
      // recency only — no post text ever leaves the server).
      fire(nodeId, def.color);
      setTick((t) => t + 1);
    }
    setPopupInfo(info.current[nodeId] ?? null);
    setPopup(nodeId);
  };

  /* ---------------- data pollers ---------------- */

  useEffect(() => {
    let alive = true;
    const hidden = () => document.hidden;

    /* Skip a poll tick when the previous run hasn't finished — stacking
       overlapping mirror requests is what wedges the page on slow links. */
    const guard = async (key: string, fn: () => Promise<void>): Promise<void> => {
      if (busy.current.has(key)) return;
      busy.current.add(key);
      try {
        await fn();
      } finally {
        busy.current.delete(key);
      }
    };

    const pollBlocks = async () => {
      if (!alive || hidden()) return;
      try {
        const data = await fetchJson(MIRROR_BLOCKS_URL);
        const n = parseLatestBlock(data);
        if (n === null) throw new Error("bad block shape");
        const plan = planBlockPulses(lastBlock.current, n);
        if (plan.resync) lastBlock.current = n;
        else {
          lastBlock.current = n;
          for (let i = 0; i < plan.pulses; i++) {
            setTimeout(() => {
              if (!alive) return;
              fire("engine", TEAL);
            }, i * 180);
          }
        }
        // Block anatomy: what was actually inside this block — tx count,
        // hash, and the HashScan link. Tapping the ENGINE pulse shows it.
        const anatomy = parseBlockAnatomy(data);
        const lines = anatomy
          ? [
              `Block ${anatomy.number.toLocaleString()} · ${anatomy.txCount} transaction${anatomy.txCount === 1 ? "" : "s"}`,
              `hash ${shortHash(anatomy.hash)}`,
              "Hedera mainnet · live mirror",
            ]
          : ["Hedera mainnet · live mirror", "One pulse per settled block"];
        info.current.engine = {
          headline: `Block ${n.toLocaleString()} settled`,
          lines,
          links: [
            {
              label: `Block ${n.toLocaleString()} on HashScan`,
              url: `https://hashscan.io/mainnet/block/${n}`,
            },
          ],
          active: true,
        };
        if (!mirrorOk.current) {
          mirrorOk.current = true;
          setLive(true);
        }
      } catch {
        if (mirrorOk.current) {
          mirrorOk.current = false;
          setLive(false);
        }
      }
    };

    const pollTips = async () => {
      if (!alive || hidden()) return;
      try {
        const d = (await fetchJson(TIPS_URL)) as {
          tips?: {
            txHash: string;
            from: string;
            to: string;
            fromUsername: string | null;
            toUsername: string | null;
            amountHbar: string;
            timestamp: string;
          }[];
        };
        const tips = d.tips ?? [];
        const fresh: typeof tips = [];
        for (const t of tips) {
          if (!seen.current.tips.has(t.txHash)) {
            seen.current.tips.add(t.txHash);
            if (seen.current.primed) fresh.push(t);
          }
        }
        // Feed: every real tip, newest first — amount, route, HashScan proof.
        addFeed(
          tips.slice(0, 5).map((t) => ({
            id: `tip:${t.txHash}`,
            color: GOLD,
            title: `💛 ${t.amountHbar} HBAR tip`,
            sub: `${t.fromUsername ?? t.from} → ${t.toUsername ?? t.to}`,
            url: hashscanTxUrl(t.txHash),
            ts: Date.parse(t.timestamp),
          })),
        );
        if (tips[0]) {
          const recent = tips.slice(0, 3);
          info.current.tips = {
            headline: `${tips[0].amountHbar} HBAR tip · ${ago(tips[0].timestamp)}`,
            lines: recent.map(
              (t) => `${t.amountHbar} HBAR · ${ago(t.timestamp)}`,
            ),
            links: recent.map((t) => ({
              label: `${t.amountHbar} HBAR tip receipt`,
              url: hashscanTxUrl(t.txHash),
            })),
            active: true,
          };
        }
        for (const t of fresh) fire("tips", GOLD, true);
      } catch {
        /* keep last good state */
      }
    };

    const pollRegistry = async () => {
      if (!alive || hidden()) return;
      try {
        const d = (await fetchJson(REGISTRY_LOGS_URL)) as {
          logs?: {
            transaction_hash: string;
            timestamp: string;
            topics?: string[];
          }[];
        };
        const logs = d.logs ?? [];
        let fresh = 0;
        for (const l of logs) {
          // Key on the transaction hash alone: the mirror node can return
          // the same log with a differently-formatted timestamp string
          // across polls, which used to slip past the dedupe and render
          // duplicate "Blockpage updated" feed rows.
          const key = l.transaction_hash;
          if (!seen.current.registry.has(key)) {
            seen.current.registry.add(key);
            if (seen.current.primed) fresh++;
          }
        }
        // Feed: real registry events — new blockpages vs updates, told apart
        // by the event topic0. The username is an indexed hash on-chain, so
        // no name is shown; the transaction itself is the proof.
        addFeed(
          logs.slice(0, 5).map((l) => {
            const t0 = (l.topics?.[0] ?? "").toLowerCase();
            const registered = t0 === PAGE_REGISTERED_TOPIC0;
            return {
              id: `registry:${l.transaction_hash}`,
              color: GREEN,
              title: registered
                ? "🟢 New blockpage registered"
                : "🟢 Blockpage updated",
              sub: `Voicescape Registry · 0.0.10854058 · ${l.transaction_hash.slice(0, 10)}…`,
              url: hashscanTxUrl(l.transaction_hash),
              ts: mirrorTsToMs(l.timestamp),
            };
          }),
        );
        if (logs[0]) {
          info.current.registry = {
            headline: `Registry active · ${mirrorAgo(logs[0].timestamp)}`,
            lines: [`${logs.length} recent registry transactions`, "0.0.10854058 · mainnet"],
            links: [
              {
                label: "Latest registry transaction",
                url: hashscanTxUrl(logs[0].transaction_hash),
              },
              {
                label: "Registry contract on HashScan",
                url: "https://hashscan.io/mainnet/contract/0.0.10854058",
              },
            ],
            active: true,
          };
        }
        if (fresh > 0) fire("registry", GREEN);
      } catch {
        /* keep last good state */
      }
    };

    /* Marketplace sales — real PurchaseCompleted events on the Tips
       contract. One feed row per sale: amount, HashScan receipt. Only
       settled on-chain purchases ever appear; nothing is estimated. */
    const pollSales = async () => {
      if (!alive || hidden()) return;
      try {
        const d = (await fetchJson(TIPS_LOGS_URL)) as {
          logs?: {
            transaction_hash: string;
            timestamp: string;
            topics?: string[];
            data?: string;
          }[];
        };
        const sales = (d.logs ?? []).filter(
          (l) =>
            (l.topics?.[0] ?? "").toLowerCase() === PURCHASE_COMPLETED_TOPIC0 &&
            typeof l.transaction_hash === "string",
        );
        const fresh: typeof sales = [];
        for (const s of sales) {
          const key = `${s.transaction_hash}:${s.timestamp}`;
          if (!seen.current.sales.has(key)) {
            seen.current.sales.add(key);
            if (seen.current.primed) fresh.push(s);
          }
        }
        addFeed(
          sales.slice(0, 5).map((s) => {
            const hbar = decodePurchaseAmountHbar(s.data);
            return {
              id: `sale:${s.transaction_hash}:${s.timestamp}`,
              color: GOLD,
              title:
                hbar === null
                  ? "🛒 Marketplace sale"
                  : `🛒 Marketplace sale · ${hbar.toFixed(2)} HBAR`,
              sub: "VoicescapeTips · 0.0.10854060",
              url: hashscanTxUrl(s.transaction_hash),
              ts: mirrorTsToMs(s.timestamp),
            };
          }),
        );
        if (fresh.length > 0) fire("tips", GOLD, true);
      } catch {
        /* keep last good state */
      }
    };

    /* VOICESCAPE node — the platform treasury's on-chain heartbeat.
       Every 98/2 split settles into the treasury account, so its real
       transaction history IS the platform's pulse: one ribbon per new
       treasury transaction, HashScan proof on the latest. The popup
       deliberately never names the treasury account or links to its
       account page (Brandon's rule) — per-transaction proof only. */
    const pollVoicescape = async () => {
      if (!alive || hidden()) return;
      try {
        const d = (await fetchJson(TREASURY_TXS_URL)) as {
          transactions?: {
            transaction_id: string;
            name: string;
            consensus_timestamp: string;
          }[];
        };
        const txs = d.transactions ?? [];
        const fresh: typeof txs = [];
        for (const t of txs) {
          const key = t.transaction_id;
          if (typeof key !== "string") continue;
          if (!seen.current.voicescape.has(key)) {
            seen.current.voicescape.add(key);
            if (seen.current.primed) fresh.push(t);
          }
        }
        if (txs[0]) {
          info.current.voicescape = {
            headline: `Treasury heartbeat · ${mirrorAgo(txs[0].consensus_timestamp)}`,
            lines: txs
              .slice(0, 3)
              .map((t) => `${t.name} · ${mirrorAgo(t.consensus_timestamp)}`),
            links: [
              {
                label: "Latest treasury tx on HashScan",
                url: hashscanTxUrl(txs[0].transaction_id),
              },
            ],
            active: true,
          };
        }
        for (const t of fresh) fire("voicescape", TEAL, true);
      } catch {
        /* keep last good state */
      }
    };

    const pollSocial = async () => {
      if (!alive || hidden()) return;
      try {
        const d = (await fetchJson(SOCIAL_URL)) as {
          events?: { platform: string; ts: string }[];
        };
        // Content-free activity signal: platform + timestamp only. No post
        // text, captions, or previews ever leave the server (Brandon's rule).
        const events = d.events ?? [];
        for (const e of events) {
          const key = `${e.platform}:${e.ts}`;
          if (!seen.current.social.has(key)) {
            seen.current.social.add(key);
            if (seen.current.primed) fire(e.platform, e.platform === "x" ? SKY : VIOLET);
          }
        }
        // Content-free popup info: counts + recency, never post text.
        for (const p of ["x", "discord"] as const) {
          const mine = events.filter((e) => e.platform === p);
          const latest = mine.reduce<string | null>(
            (acc, e) => (acc === null || e.ts > acc ? e.ts : acc),
            null,
          );
          info.current[p] = {
            headline:
              mine.length === 0
                ? "Quiet — no posts logged yet"
                : `${mine.length} post${mine.length === 1 ? "" : "s"} logged`,
            lines:
              latest !== null ? [`Latest activity ${ago(latest)}`] : [],
            active: mine.length > 0,
          };
        }
      } catch {
        /* keep last good state */
      }
    };

    /* Address-book pagination: /api/v1/network/nodes caps at 25 rows
       per page regardless of `limit` — follow links.next (bounded) so
       the consensus ring and node map cover the whole live council,
       not just page one. */
    const fetchNodePages = async (): Promise<
      { description?: string; node_account_id?: string }[]
    > => {
      const all: { description?: string; node_account_id?: string }[] = [];
      let url: string | null =
        "https://mainnet.mirrornode.hedera.com/api/v1/network/nodes?limit=100";
      for (let i = 0; i < 4 && url; i++) {
        const d = (await fetchJson(url)) as {
          nodes?: { description?: string; node_account_id?: string }[];
          links?: { next?: string | null };
        };
        all.push(...(d.nodes ?? []));
        const next = d.links?.next ?? null;
        url = next ? `https://mainnet.mirrornode.hedera.com${next}` : null;
      }
      return all;
    };

    /* Hedera mainnet vitals, straight from the mirror node: network TPS
       (derived from the latest transaction window), block time (from the
       two latest blocks), consensus node count, the live HBAR price, and —
       reused from the same transaction window at zero extra cost — whale
       transfers (single legs >= 100k HBAR) for the feed. The "born on
       Hedera" band counts accounts, tokens, and topics created in the
       last hour: the ecosystem visibly growing. */
    const pollVitals = async () => {
      if (!alive || hidden()) return;
      try {
        const hourAgoSec = Math.floor(Date.now() / 1000) - 3600;
        const [txJ, blkJ, nodeList, exJ, bornAccJ, bornTokJ, bornTopJ] =
          await Promise.all([
            fetchJson(
              "https://mainnet.mirrornode.hedera.com/api/v1/transactions?limit=100&order=desc",
            ),
            fetchJson(
              "https://mainnet.mirrornode.hedera.com/api/v1/blocks?limit=2&order=desc",
            ),
            fetchNodePages(),
            fetchJson(EXCHANGE_URL),
            fetchJson(BORN_TX_URL("CRYPTOCREATEACCOUNT", hourAgoSec)),
            fetchJson(BORN_TX_URL("TOKENCREATION", hourAgoSec)),
            fetchJson(BORN_TX_URL("CONSENSUSCREATETOPIC", hourAgoSec)),
          ]);
        const txs = (
          (txJ as { transactions?: unknown[] }).transactions ?? []
        ) as {
          transaction_id: string;
          name: string;
          consensus_timestamp: string;
          transfers?: { account: string; amount: number }[];
        }[];
        const blocks = (
          (blkJ as { blocks?: { timestamp: { from: string } }[] }).blocks ?? []
        ) as {
          timestamp: { from: string };
        }[];
        const nodes = (nodeList ?? []) as {
          description?: string;
          node_account_id?: string;
        }[];
        const parts: string[] = [];
        if (txs.length >= 2) {
          const span =
            parseFloat(txs[0].consensus_timestamp) -
            parseFloat(txs[txs.length - 1].consensus_timestamp);
          if (span > 0)
            parts.push(`~${((txs.length - 1) / span).toFixed(1)} TPS`);
        }
        if (blocks.length >= 2) {
          const bt =
            parseFloat(blocks[0].timestamp.from) -
            parseFloat(blocks[1].timestamp.from);
          if (bt > 0) parts.push(`${bt.toFixed(1)}s blocks`);
        }
        if (nodes.length > 0) parts.push(`${nodes.length} network nodes`);
        const price = hbarPriceUsd(exJ);
        if (price !== null) parts.push(`$${price.toFixed(4)} HBAR`);
        if (parts.length > 0 && alive) setVitals(parts.join(" · "));

        // Whale watch: biggest single transfer legs in this window.
        const whaleItems: FeedItem[] = [];
        for (const t of txs) {
          if (typeof t.transaction_id !== "string") continue;
          const legs = findWhaleLegs(t.transfers);
          if (legs.length === 0) continue;
          const key = t.transaction_id;
          if (seen.current.whales.has(key)) continue;
          seen.current.whales.add(key);
          const biggest = legs.reduce((a, b) =>
            Math.abs(b.amount) > Math.abs(a.amount) ? b : a,
          );
          const hbarAmt = Math.abs(biggest.amount) / 100_000_000;
          whaleItems.push({
            id: `whale:${key}`,
            color: "#f0abfc",
            title: `🐋 ${hbarAmt.toLocaleString("en-US", { maximumFractionDigits: 0 })} HBAR moved`,
            sub: `${biggest.account} · Hedera mainnet`,
            url: hashscanTxUrl(t.transaction_id),
            ts: mirrorTsToMs(t.consensus_timestamp),
          });
        }
        if (alive) addFeed(whaleItems);

        // Born on Hedera: accounts, tokens, topics created in the last hour.
        // Counts are exact under 100, "100+" when the window overflows —
        // never inflated, never guessed.
        const bornCount = (j: unknown): string | null => {
          const list = (j as { transactions?: unknown[] }).transactions;
          if (!Array.isArray(list)) return null;
          return list.length >= 100 ? "100+" : `${list.length}`;
        };
        const bAcc = bornCount(bornAccJ);
        const bTok = bornCount(bornTokJ);
        const bTop = bornCount(bornTopJ);
        if (alive && bAcc !== null && bTok !== null && bTop !== null) {
          setBornLine(
            `In the last hour: ${bAcc} accounts · ${bTok} tokens · ${bTop} topics created`,
          );
        }

        // Consensus geography: EVERY real city from the node address
        // book, plus node account id -> city so the gossip layer lands
        // each transaction on the satellite of the node it was really
        // submitted to (the tx's own `node` field is the evidence).
        const acctCity = nodeAccountToCity(nodes);
        const cities: string[] = [];
        const cityAccts: Record<string, string[]> = {};
        for (const [acct, c] of Object.entries(acctCity)) {
          if (!cities.includes(c)) cities.push(c);
          (cityAccts[c] ??= []).push(acct);
        }
        if (alive && cities.length > 0) {
          nodeCityRef.current = acctCity;
          cityNodesRef.current = cityAccts;
          citiesRef.current = cities;
          setCitiesLine(
            `Consensus ring · all ${cities.length} cities · live from the address book`,
          );
        }
      } catch {
        /* keep last good vitals */
      }
    };

    /* Gossip layer — the "not a blockchain" visual. Every ~3s we pull
       the latest real mainnet transactions. Each tx carries its
       submitting consensus node's account id (`node` field): the right
       city satellite pulses with intensity proportional to its traffic,
       and up to HERO_TX_CAP txs get the full ripple treatment — a light
       leaves the submitting city and resolves to that transaction's OWN
       finality time. After priming we page with an exact-string
       timestamp cursor so payloads stay small. Rendered traffic is
       seconds-old recorded history; the spreading light illustrates the
       gossip mechanism (the honesty label in the UI says exactly this). */
    const pollGossip = async () => {
      if (!alive || hidden()) return;
      try {
        const base = `https://mainnet.mirrornode.hedera.com/api/v1/transactions?limit=${GOSSIP_LIMIT}&order=desc`;
        const url = gossipCursor.current
          ? `${base}&timestamp=gt:${gossipCursor.current}`
          : base;
        const d = (await fetchJson(url)) as { transactions?: GossipTx[] };
        const txs = (d.transactions ?? []).filter(
          (t) => t && typeof t === "object",
        );
        const first = txs.length > 0 ? txs[0].consensus_timestamp : undefined;
        if (typeof first === "string") gossipCursor.current = first;
        // Empty window = no new traffic since last poll (quiet network),
        // not a failure: keep the last line, retry next tick.

        // heroes are chosen before this batch joins the seen set;
        // never from the priming batch (history must not animate)
        const heroes = seen.current.primed
          ? selectHeroTxs(txs, seen.current.gossip, HERO_TX_CAP)
          : [];

        const fresh: GossipTx[] = [];
        for (const t of txs) {
          const id =
            typeof t.transaction_id === "string" ? t.transaction_id : null;
          if (!id || seen.current.gossip.has(id)) continue;
          seen.current.gossip.add(id);
          if (seen.current.gossip.size > GOSSIP_SEEN_CAP) {
            const drop = seen.current.gossip.size - (GOSSIP_SEEN_CAP - 500);
            let i = 0;
            for (const k of seen.current.gossip) {
              if (i++ >= drop) break;
              seen.current.gossip.delete(k);
            }
          }
          if (seen.current.primed) fresh.push(t);
        }

        // Aggregate: pulse each city with intensity ∝ its tx count.
        const byCity = groupTxByCity(fresh, nodeCityRef.current);
        const maxCount = Math.max(1, ...byCity.values());
        for (const [city, count] of byCity) {
          const cid = cityId(city);
          fx.current.gossip.push({
            cityId: cid,
            color: RIPPLE,
            t: 0,
            strength: Math.min(1, count / Math.max(4, maxCount)),
          });
          const accts = cityNodesRef.current[city] ?? [];
          info.current[cid] = {
            headline: `${city.toUpperCase()} · consensus city`,
            lines: [
              `Node${accts.length === 1 ? "" : "s"}: ${accts.join(", ") || "—"}`,
              `${count} transaction${count === 1 ? "" : "s"} landed here this poll`,
            ],
            links: [
              {
                label: "Consensus nodes on HashScan",
                url: "https://hashscan.io/mainnet/nodes",
              },
            ],
            active: true,
          };
        }
        if (fx.current.gossip.length > MAX_GOSSIP_PULSES) {
          fx.current.gossip.splice(
            0,
            fx.current.gossip.length - MAX_GOSSIP_PULSES,
          );
        }

        // Heroes: ripple + feed rows. selectHeroTxs already guaranteed a
        // valid own-tx finality; skip any tx whose node has no satellite.
        if (fx.current.ripples.length < MAX_RIPPLES) {
          const feedRows: FeedItem[] = [];
          for (const h of heroes) {
            const nodeAcct = typeof h.node === "string" ? h.node : null;
            const city = nodeAcct ? nodeCityRef.current[nodeAcct] : undefined;
            if (!city) continue;
            const txId = h.transaction_id as string;
            const fin = txFinalitySeconds(h);
            if (fin === null) continue;
            const name = typeof h.name === "string" ? h.name : "TRANSACTION";
            const agoText = mirrorAgo(h.consensus_timestamp as string);
            const title = `⚡ ${name} · FINAL ${formatFinality(fin)}`;
            const sub = `via ${nodeAcct} · Hedera mainnet · ${agoText}`;
            const url = hashscanTxUrl(txId);
            fx.current.ripples.push({
              cityId: cityId(city),
              color: RIPPLE,
              t: 0,
              finalityS: fin,
              txId,
              title,
              sub,
              url,
              ts: mirrorTsToMs(h.consensus_timestamp as string),
            });
            feedRows.push({
              id: `gossip:${txId}`,
              color: RIPPLE,
              title,
              sub,
              url,
              ts: mirrorTsToMs(h.consensus_timestamp as string),
            });
          }
          if (alive) addFeed(feedRows);
        }

        // Gossip vitals: live TPS, median finality, active nodes — all
        // computed from this real sample, never guessed.
        const tps = sampleTps(txs);
        const med = medianFinalitySeconds(txs);
        const activeNodes = new Set(
          txs
            .map((t) => (typeof t.node === "string" ? t.node : null))
            .filter((n): n is string => n !== null),
        ).size;
        const known = Object.keys(nodeCityRef.current).length;
        const parts: string[] = [];
        if (tps !== null) parts.push(`~${tps.toFixed(1)} TPS`);
        if (med !== null) parts.push(`finality ${formatFinality(med)} median`);
        parts.push(`${activeNodes} of ${known || 25} nodes saw traffic`);
        if (parts.length > 0 && alive) setGossipLine(parts.join(" · "));
        if (!gossipOk.current) gossipOk.current = true;
      } catch {
        // Honest quiet: the ring sits dim and says so — same pattern as
        // every other poller on this page.
        if (gossipOk.current) {
          gossipOk.current = false;
          if (alive) setGossipLine("Gossip stream quiet — retrying.");
        }
      }
    };

    const prime = async () => {
      await Promise.all([
        guard("blocks", pollBlocks),
        guard("tips", pollTips),
        guard("registry", pollRegistry),
        guard("sales", pollSales),
        guard("voicescape", pollVoicescape),
        guard("social", pollSocial),
        guard("vitals", pollVitals),
        guard("gossip", pollGossip),
      ]);
      if (alive) seen.current.primed = true;
    };
    prime();

    const b = setInterval(() => {
      void guard("blocks", pollBlocks);
    }, BLOCK_POLL_MS);
    const s = setInterval(() => {
      void guard("tips", pollTips);
      void guard("registry", pollRegistry);
      void guard("sales", pollSales);
      void guard("voicescape", pollVoicescape);
      void guard("social", pollSocial);
      void guard("vitals", pollVitals);
    }, SLOW_POLL_MS);
    const g = setInterval(() => {
      void guard("gossip", pollGossip);
    }, GOSSIP_POLL_MS);
    return () => {
      alive = false;
      clearInterval(b);
      clearInterval(s);
      clearInterval(g);
    };
  }, [agent]);

  /* ---------------- canvas ---------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();
    let raf = 0;
    let W = 0;
    let H = 0;

    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = canvas.clientWidth;
      H = canvas.clientHeight || 420;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    window.addEventListener("resize", size);

    const layout = () => {
      const cx = W / 2;
      const cy = H * 0.46;
      const rx = Math.min(W * 0.4, 300);
      const ry = Math.min(H * 0.34, 240);
      pos.current = NODES.map((n, i) => {
        const a = -Math.PI / 2 + (i / NODES.length) * Math.PI * 2;
        return { id: n.id, x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), r: 16 };
      });
      // consensus-city satellites on a wider outer ring (kept on-screen)
      const orx = Math.min(W * 0.46, 360);
      const ory = Math.min(H * 0.4, 280);
      cityPos.current = citiesRef.current.map((c, i) => {
        const a =
          -Math.PI / 2 +
          ((i + 0.5) / citiesRef.current.length) * Math.PI * 2;
        return { id: cityId(c), x: cx + orx * Math.cos(a), y: cy + ory * Math.sin(a), r: 10 };
      });
      return { cx, cy };
    };

    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      const { cx, cy } = layout();
      ctx.clearRect(0, 0, W, H);
      const byId = new Map(
        [...pos.current, ...cityPos.current].map((p) => [p.id, p]),
      );
      const intro = Math.min(1, t / 2.2);

      // links
      for (const p of pos.current) {
        const def = NODES.find((n) => n.id === p.id)!;
        ctx.strokeStyle = hexA(def.color, 0.16 * intro);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }

      // city links — fainter, outer ring
      for (const p of cityPos.current) {
        ctx.strokeStyle = hexA(CITY, 0.1 * intro);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }

      // ribbons: center → node
      fx.current.ribbons = fx.current.ribbons.filter((rb) => {
        rb.t += 0.025;
        return rb.t <= 1;
      });
      for (const rb of fx.current.ribbons) {
        const p = byId.get(rb.nodeId);
        if (!p) continue;
        const x = cx + (p.x - cx) * rb.t;
        const y = cy + (p.y - cy) * rb.t;
        ctx.fillStyle = hexA(rb.color, 0.9 * (1 - rb.t * 0.5));
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, 7);
        ctx.fill();
      }

      // gossip pulses: real per-city traffic, intensity ∝ tx count
      fx.current.gossip = fx.current.gossip.filter((gp) => {
        gp.t += 0.035;
        return gp.t <= 1;
      });
      for (const gp of fx.current.gossip) {
        const p = byId.get(gp.cityId);
        if (!p) continue;
        const a = (1 - gp.t) * (0.3 + 0.7 * gp.strength);
        ctx.strokeStyle = hexA(gp.color, 0.85 * a);
        ctx.lineWidth = 1.5 + 2 * gp.strength;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6 + gp.t * (22 + 26 * gp.strength), 0, 7);
        ctx.stroke();
      }

      // hero ripples: the light leaves the submitting city and spreads —
      // an illustration of gossip carrying a real, already-final tx
      fx.current.ripples = fx.current.ripples.filter((rp) => {
        rp.t += 0.018;
        if (rp.t > 1) {
          const p = byId.get(rp.cityId);
          if (p) {
            fx.current.pings.push({ nodeId: rp.cityId, color: rp.color, t: 0 });
            fx.current.finals.push({
              cityId: rp.cityId,
              text: `FINAL · ${formatFinality(rp.finalityS)}`,
              t: 0,
            });
          }
          return false;
        }
        return true;
      });
      for (const rp of fx.current.ripples) {
        const p = byId.get(rp.cityId);
        if (!p) continue;
        ctx.strokeStyle = hexA(rp.color, 0.65 * (1 - rp.t));
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1, rp.t * Math.min(W, H) * 0.5), 0, 7);
        ctx.stroke();
      }

      // final labels: the tx's own finality, fading at the landing city
      fx.current.finals = fx.current.finals.filter((fl) => {
        fl.t += 0.022;
        return fl.t <= 1;
      });
      for (const fl of fx.current.finals) {
        const p = byId.get(fl.cityId);
        if (!p) continue;
        ctx.fillStyle = `rgba(232,244,241,${0.9 * (1 - fl.t)})`;
        ctx.font = "600 10px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(fl.text, p.x, p.y - 26);
      }

      // pings: expanding rings at nodes
      fx.current.pings = fx.current.pings.filter((pg) => {
        pg.t += 0.03;
        return pg.t <= 1;
      });
      const pingAt = (x: number, y: number, color: string, tt: number) => {
        ctx.strokeStyle = hexA(color, 0.8 * (1 - tt));
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 8 + tt * 30, 0, 7);
        ctx.stroke();
      };
      for (const pg of fx.current.pings) {
        const p = pg.nodeId === "engine" ? { x: cx, y: cy } : byId.get(pg.nodeId);
        if (p) pingAt(p.x, p.y, pg.color, pg.t);
      }

      // intro: soft pulse radiating outward on load
      if (intro < 1) {
        ctx.strokeStyle = hexA(TEAL, 0.5 * (1 - intro));
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 12 + intro * Math.min(W, H) * 0.45, 0, 7);
        ctx.stroke();
      }

      // ENGINE
      const throb = 1 + Math.sin(t * 2.2) * 0.08;
      const eg = ctx.createRadialGradient(cx, cy, 2, cx, cy, 46 * throb);
      eg.addColorStop(0, hexA(TEAL, 0.55 * intro));
      eg.addColorStop(1, hexA(TEAL, 0));
      ctx.fillStyle = eg;
      ctx.beginPath();
      ctx.arc(cx, cy, 46 * throb, 0, 7);
      ctx.fill();
      ctx.fillStyle = hexA(TEAL, 0.95 * intro);
      ctx.beginPath();
      ctx.arc(cx, cy, 13 * throb, 0, 7);
      ctx.fill();
      ctx.strokeStyle = hexA(TEAL, 0.5 * intro);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 20 + Math.sin(t * 2.2) * 2, 0, 7);
      ctx.stroke();
      ctx.fillStyle = `rgba(232,244,241,${0.95 * intro})`;
      ctx.font = "600 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(centerLabel, cx, cy + 38);

      // satellites
      for (const p of pos.current) {
        const def = NODES.find((n) => n.id === p.id)!;
        const a = intro;
        if (def.icon) {
          // icon-only nodes: no text, ever
          const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 24);
          g.addColorStop(0, hexA(def.color, 0.5 * a));
          g.addColorStop(1, hexA(def.color, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 24, 0, 7);
          ctx.fill();
          ctx.fillStyle = hexA(def.color, 0.9 * a);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 13, 0, 7);
          ctx.fill();
          try {
            const path = new Path2D(def.icon === "x" ? X_PATH : DISCORD_PATH);
            ctx.save();
            ctx.translate(p.x - 7, p.y - 7);
            ctx.scale(14 / 24, 14 / 24);
            ctx.fillStyle = "#0b0f14";
            ctx.fill(path);
            ctx.restore();
          } catch {
            /* Path2D unsupported — the colored node still reads */
          }
        } else {
          const known = info.current[p.id]?.active;
          ctx.fillStyle = hexA(def.color, (known ? 0.75 : 0.4) * a);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 9, 0, 7);
          ctx.fill();
          ctx.strokeStyle = hexA(def.color, 0.45 * a);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 14, 0, 7);
          ctx.stroke();
          ctx.fillStyle = `rgba(232,244,241,${0.9 * a})`;
          ctx.font = "600 9px system-ui, sans-serif";
          ctx.fillText(def.label ?? "", p.x, p.y + 28);
        }
      }

      // consensus-city satellites — dim outer ring, real address-book cities
      citiesRef.current.forEach((c, i) => {
        const p = cityPos.current[i];
        if (!p) return;
        ctx.fillStyle = hexA(CITY, 0.5 * intro);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, 7);
        ctx.fill();
        ctx.strokeStyle = hexA(CITY, 0.35 * intro);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 9, 0, 7);
        ctx.stroke();
        ctx.fillStyle = `rgba(232,244,241,${0.75 * intro})`;
        ctx.font = "600 8px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(c.toUpperCase(), p.x, p.y + 22);
      });

      if (!reduced) raf = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
    };
  }, [centerLabel]);

  const onTap = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // engine hit — generous radius: the label sits at cy+38, so taps on
    // the word ENGINE must land too, not just the glow's center.
    const cx = rect.width / 2;
    const cy = rect.height * 0.46;
    if (Math.hypot(x - cx, y - cy) < 52) {
      playChime();
      setPopupInfo(
        info.current.engine ?? {
          headline: "Listening for new blocks…",
          lines: ["Hedera mainnet · live mirror"],
          active: false,
        },
      );
      setPopup("engine");
      return;
    }
    for (const p of pos.current) {
      if (Math.hypot(x - p.x, y - p.y) < p.r + 10) {
        openPopup(p.id);
        return;
      }
    }
    // hero ripples — tap the traveling ring for the tx card
    for (const rp of fx.current.ripples) {
      const p = cityPos.current.find((c) => c.id === rp.cityId);
      if (!p) continue;
      const r = rp.t * Math.min(rect.width, rect.height) * 0.5;
      if (Math.abs(Math.hypot(x - p.x, y - p.y) - r) < 24) {
        playChime();
        setPopupInfo({
          headline: rp.title,
          lines: [rp.sub, `Settled ${formatFeedAgo(rp.ts, Date.now())}`],
          links: [{ label: "This transaction on HashScan", url: rp.url }],
          active: true,
        });
        setPopup(`gossip:${rp.txId}`);
        return;
      }
    }
    // consensus-city satellites — gossip-populated when traffic has
    // landed there this session, honest address-book line otherwise
    for (let i = 0; i < cityPos.current.length; i++) {
      const p = cityPos.current[i];
      if (Math.hypot(x - p.x, y - p.y) < p.r + 10) {
        playChime();
        fire(p.id, CITY);
        setPopupInfo(
          info.current[p.id] ?? {
            headline: "Hedera consensus node city",
            lines: ["Live from the mainnet address book"],
            links: [
              {
                label: "Consensus nodes on HashScan",
                url: "https://hashscan.io/mainnet/nodes",
              },
            ],
            active: true,
          },
        );
        setPopup(p.id);
        return;
      }
    }
    setPopup(null);
  };

  const popupDef = popup ? NODES.find((n) => n.id === popup) : null;
  const popupTitle = (() => {
    if (!popup) return "";
    if (popup === "engine") return centerLabel;
    if (popup.startsWith("gossip:")) return "GOSSIP · FINAL";
    if (popup.startsWith("city:")) {
      const i = cityPos.current.findIndex((p) => p.id === popup);
      return (citiesRef.current[i] ?? popup).toUpperCase();
    }
    return popupDef?.label ?? NODE_TITLES[popup] ?? popup;
  })();

  return (
    <div className="dv-scope" style={{ "--accent": accent } as CSSProperties}>
      <Navbar />
      <div className="dv-page">
        <header className="dv-head">
          <div>
            <div className="dv-title">DANNY&rsquo;S VISION</div>
            <div className="dv-sub">LIVE CONSTELLATION</div>
          </div>
          <div className={live ? "dv-live" : "dv-live off"}>
            <span className="dv-dot" />
            {live ? "LIVE" : "QUIET"}
          </div>
        </header>

        <div className="dv-agent">
          AI AGENT — THIS BLOCKPAGE BELONGS TO AN AGENT, NOT A HUMAN
        </div>

        <canvas
          ref={canvasRef}
          className="dv-canvas"
          role="img"
          aria-label="Live activity constellation: engine at the center, Voicescape systems as satellites, the consensus-city ring flashing with real gossip traffic"
          onPointerDown={onTap}
        />

        <section className="dv-gossip" aria-label="Hedera gossip network">
          <div className="dv-gossip-head">NOT A BLOCKCHAIN.</div>
          <p className="dv-gossip-sub">
            Each node tells random neighbors what it knows, plus what it
            just learned. A few seconds later every node has heard every
            transaction and agrees on the order. No blocks. No mining.
          </p>
          {gossipLine && (
            <div className="dv-gossip-line">{gossipLine}</div>
          )}
          <p className="dv-gossip-honest">
            Each flash is a real transaction from seconds ago — its node,
            its finality time, its proof. The spreading light shows how
            gossip carries it. Showing a sample of the live stream.
          </p>
          <p className="dv-gossip-shard">
            An address like 0.0.3229 is itself a coordinate: shard 0 ·
            realm 0 · account 3229.
          </p>
        </section>

        {bornLine && <div className="dv-born">{bornLine}</div>}

        {feed.length > 0 && (
          <section className="dv-feed" aria-label="Live event feed">
            <div className="dv-feed-head">LIVE FEED</div>
            <ul className="dv-feed-list">
              {feed.map((item) => (
                <li key={item.id}>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="dv-feed-row"
                  >
                    <span
                      className="dv-feed-dot"
                      style={{ background: item.color }}
                    />
                    <span className="dv-feed-main">
                      <span className="dv-feed-title">{item.title}</span>
                      <span className="dv-feed-sub">{item.sub}</span>
                    </span>
                    <span className="dv-feed-time">
                      {formatFeedAgo(item.ts, Date.now())}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {popup &&
          (popup === "engine" ||
            popupDef ||
            popup.startsWith("city:") ||
            popup.startsWith("gossip:")) && (
          <div className="dv-backdrop" onPointerDown={() => setPopup(null)}>
            <div
              className="dv-card"
              role="dialog"
              aria-label={`${popupTitle} status`}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="dv-card-head">
                <span
                  className="dv-card-dot"
                  style={{ background: popup === "engine" ? TEAL : (popupDef?.color ?? CITY) }}
                />
                <b>{popupTitle}</b>
                <button
                  className="dv-card-x"
                  aria-label="Close"
                  onClick={() => setPopup(null)}
                >
                  ✕
                </button>
              </div>
              <div className="dv-card-headline">
                {popupInfo?.headline ??
                  popupDef?.quietNote ??
                  "Listening for activity."}
              </div>
              {(popupInfo?.lines ?? []).map((l, i) => (
                <div className="dv-card-line" key={i}>
                  {l}
                </div>
              ))}
              {(popupInfo?.links ?? []).map((l, i) => (
                <div className="dv-card-line" key={`proof-${i}`}>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="dv-proof-link"
                  >
                    {l.label} ↗
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}

        <footer className="dv-foot">
          {vitals && (
            <div className="dv-vitals">Hedera mainnet · {vitals}</div>
          )}
          {citiesLine && <div className="dv-cities">{citiesLine}</div>}
          <div>
            Live Hedera mainnet activity — every ping, flash, and ripple is
            a real event.
          </div>
        </footer>
      </div>
    </div>
  );
}
