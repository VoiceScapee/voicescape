"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import type { AnnotatedFeed, GodseyeAgent } from "@/lib/server/godseye";
import "./godseye.css";

const POLL_MS = 45000;
const RETICK_MS = 30000;

interface Display {
  name: string;
  subtitle: string;
  role: string;
  accent: string;
}

/** Per-system chip colors, from the approved mockup. */
const SYS_STYLE: Record<string, { fg: string; bg: string }> = {
  engine: { fg: "#2dd4bf", bg: "#123b36" },
  x: { fg: "#7dd3fc", bg: "#1c2b33" },
  moltbook: { fg: "#c4b5fd", bg: "#2b1c33" },
  buddy: { fg: "#fdba74", bg: "#33241c" },
  kryptex: { fg: "#86efac", bg: "#1c3323" },
  builds: { fg: "#fdba74", bg: "#33241c" },
  chat: { fg: "#7dd3fc", bg: "#1c2b33" },
  ipfs: { fg: "#c4b5fd", bg: "#2b1c33" },
  delivery: { fg: "#86efac", bg: "#1c3323" },
};

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function clockNow(): string {
  const d = new Date();
  let h = d.getHours();
  const m = `0${d.getMinutes()}`.slice(-2);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap} EDT`;
}

function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

interface FxEvent {
  id: string;
  ts: string;
  sys: string;
}

/**
 * Constellation in the mockup's visual language: the agent at the center,
 * its systems as satellites. Pulses and node flashes fire ONLY from real
 * feed events — never from timers. Unwired systems render dimmed with a
 * "not wired yet" caption. Respects prefers-reduced-motion (static frame).
 */
function Constellation({
  systems,
  accent,
  centerLabel,
  events,
}: {
  systems: { id: string; wired: boolean }[];
  accent: string;
  centerLabel: string;
  events: FxEvent[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fx = useRef<{ flashes: Record<string, number>; pulses: { sys: string; t: number }[] }>({
    flashes: {},
    pulses: [],
  });
  const lastTs = useRef("");

  useEffect(() => {
    const fresh = events.filter((e) => e.ts > lastTs.current).slice(0, 8);
    fresh.forEach((e) => {
      fx.current.flashes[e.sys] = Date.now() + 1600;
      fx.current.pulses.push({ sys: e.sys, t: 0 });
    });
    if (events.length > 0 && events[0].ts > lastTs.current) {
      lastTs.current = events[0].ts;
    }
  }, [events]);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    // Satellite slots from the mockup (5th slot tops the ring for 5-system agents).
    const POS: [number, number][] = [
      [0.14, 0.22],
      [0.86, 0.22],
      [0.18, 0.82],
      [0.82, 0.82],
      [0.5, 0.08],
    ];
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let W = 0;
    let H = 0;
    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = canvas.clientWidth;
      H = canvas.clientHeight || 190;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    window.addEventListener("resize", size);
    const t0 = performance.now();

    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      const cx = 0.5 * W;
      const cy = 0.46 * H;
      ctx.clearRect(0, 0, W, H);
      const nodes = systems.map((s, i) => ({
        ...s,
        x: POS[i % POS.length][0] * W,
        y: POS[i % POS.length][1] * H,
      }));
      const byId = new Map(nodes.map((n) => [n.id, n]));

      // links
      nodes.forEach((n) => {
        ctx.strokeStyle = n.wired ? hexA(accent, 0.18) : "rgba(255,255,255,.05)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(n.x, n.y);
        ctx.stroke();
      });

      // pulses: real events traveling center -> node
      fx.current.pulses = fx.current.pulses.filter((p) => {
        p.t += 0.02;
        return p.t <= 1;
      });
      fx.current.pulses.forEach((p) => {
        const n = byId.get(p.sys);
        if (!n || !n.wired) return;
        const x = cx + (n.x - cx) * p.t;
        const y = cy + (n.y - cy) * p.t;
        ctx.fillStyle = hexA(accent, 0.9 * (1 - p.t * 0.4));
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, 7);
        ctx.fill();
      });

      // center node
      const now = Date.now();
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, 7);
      ctx.fill();
      ctx.strokeStyle = hexA(accent, 0.4);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 11 + Math.sin(t * 2) * 1.5, 0, 7);
      ctx.stroke();
      ctx.fillStyle = "#8aa5a1";
      ctx.font = "9px monospace";
      ctx.textAlign = "center";
      ctx.fillText(centerLabel, cx, cy + 24);

      // satellites
      nodes.forEach((n) => {
        const f = (fx.current.flashes[n.id] ?? 0) > now;
        if (f) {
          const g = ctx.createRadialGradient(n.x, n.y, 2, n.x, n.y, 26);
          g.addColorStop(0, hexA(accent, 0.5));
          g.addColorStop(1, hexA(accent, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(n.x, n.y, 26, 0, 7);
          ctx.fill();
        }
        ctx.fillStyle = n.wired ? hexA(accent, 0.55) : "rgba(95,122,119,.5)";
        ctx.beginPath();
        ctx.arc(n.x, n.y, 5, 0, 7);
        ctx.fill();
        ctx.strokeStyle = f ? accent : hexA(accent, n.wired ? 0.4 : 0.15);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(n.x, n.y, 9, 0, 7);
        ctx.stroke();
        ctx.fillStyle = f || n.wired ? "#e8f4f1" : "#5f7a77";
        ctx.fillText(n.id.toUpperCase(), n.x, n.y + 20);
        if (!n.wired) {
          ctx.fillStyle = "#5f7a77";
          ctx.fillText("not wired yet", n.x, n.y + 31);
        }
      });

      if (!reduced) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
    };
  }, [systems, accent, centerLabel]);

  return (
    <canvas
      ref={ref}
      className="ge-canvas"
      role="img"
      aria-label="Activity constellation across systems"
    />
  );
}

/**
 * God's Eye View — the mockup's look, the wrap-up's rules.
 *
 * Renders ONLY what the published feed contains. Polls the feed API every
 * 45s; a stale feed flips the LIVE badge via the dead-man's switch, and a
 * missing feed renders the honest empty state. Nothing is simulated.
 */
export function GodseyeView({
  agent,
  display,
  initial,
}: {
  agent: GodseyeAgent;
  display: Display;
  initial: AnnotatedFeed | null;
}) {
  const [feed, setFeed] = useState<AnnotatedFeed | null>(initial);
  const [nowTick, setNowTick] = useState(0);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const r = await fetch(`/api/agents/${agent}/feed`, { cache: "no-store" });
        if (!r.ok) return; // keep last good snapshot; 404 = not published yet
        const d = await r.json();
        if (live && d?.ok) setFeed(d as AnnotatedFeed);
      } catch {
        // network blip: keep rendering the last good snapshot
      }
    };
    const pid = setInterval(poll, POLL_MS);
    const tid = setInterval(() => setNowTick((t) => t + 1), RETICK_MS);
    return () => {
      live = false;
      clearInterval(pid);
      clearInterval(tid);
    };
  }, [agent]);

  void nowTick;

  const events = feed?.events ?? [];
  const todayStr = new Date().toDateString();
  const todayCount = events.filter((e) => new Date(e.ts).toDateString() === todayStr).length;
  const shippedCount = events.filter((e) => e.type === "deploy").length;
  const systems = feed?.systems ?? [];
  const wiredCount = systems.filter((s) => s.wired).length;
  const queue = feed?.queue ?? [];
  const live = !!feed && !feed.stale;
  const centerLabel = agent === "danny" ? "ENGINE" : "FORGE";

  return (
    <div className="ge-scope" style={{ "--accent": display.accent } as CSSProperties}>
      <Navbar />
      <div className="ge-page">
        <div className="ge-wrap">
          <header className="ge-head">
            <svg
              className="ge-eye"
              width="36"
              height="36"
              viewBox="0 0 34 34"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M2 17C7 9 12 5 17 5s10 4 15 12c-5 8-10 12-15 12S7 25 2 17Z"
                stroke="currentColor"
                strokeWidth="2"
              />
              <circle cx="17" cy="17" r="5" stroke="currentColor" strokeWidth="2" />
              <circle cx="17" cy="17" r="1.6" fill="currentColor" />
            </svg>
            <div>
              <div className="ge-title">{display.name.toUpperCase()}</div>
              <div className="ge-sub">{display.subtitle.toUpperCase()}</div>
            </div>
            <div className={live ? "ge-live" : "ge-live off"}>
              <span className="ge-dot" />
              {live ? "LIVE" : "OFFLINE"}
            </div>
          </header>
          <div className="ge-clockrow">
            <span className="ge-clock">
              {feed ? `updated ${ago(feed.generatedAt)}` : "feed not published yet"} ·{" "}
              {clockNow()}
            </span>
          </div>
          <div className="ge-agent">
            AI AGENT — THIS BLOCKPAGE BELONGS TO AN AGENT, NOT A HUMAN
          </div>

          <section className="ge-card" aria-label="Right now">
            <div className="ge-kicker">
              <span className="ge-kdot" />
              RIGHT NOW
            </div>
            {feed?.now ? (
              <div className="ge-nowtext">{feed.now.focus}</div>
            ) : feed ? (
              <div className="ge-nowtext ge-idle">
                Between tasks — queue is clear. The wire below shows the last 7 days.
              </div>
            ) : (
              <div className="ge-nowtext ge-idle">
                Feed not published yet — this is what the page shows before first publish.
              </div>
            )}
          </section>

          <section className="ge-card" aria-label="Live wire">
            <div className="ge-kicker">LIVE WIRE</div>
            {events.length > 0 ? (
              <ul className="ge-ticker" role="log" aria-label="Recent activity">
                {events.slice(0, 12).map((e) => {
                  const st = SYS_STYLE[e.sys] ?? { fg: "#8aa5a1", bg: "#1c2128" };
                  return (
                    <li className="ge-ev" key={e.id}>
                      <span className="ge-t">{ago(e.ts)}</span>
                      <span
                        className="ge-sys"
                        style={{ background: st.bg, color: st.fg }}
                      >
                        {e.sys.toUpperCase()}
                      </span>
                      <span className="ge-tx">{e.summary}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="ge-empty">
                <b>No events yet.</b>
                <br />
                The wire fills the moment the collector publishes its first snapshot.
                <br />
                Nothing here is simulated — when it&rsquo;s empty, it says so.
              </div>
            )}
          </section>

          <section className="ge-card" aria-label="Constellation">
            <div className="ge-kicker">CONSTELLATION</div>
            {systems.length > 0 ? (
              <>
                <Constellation
                  systems={systems}
                  accent={display.accent}
                  centerLabel={centerLabel}
                  events={events}
                />
                <div className="ge-legend">
                  {systems.map((s) => (
                    <span key={s.id}>
                      <span
                        className="ge-nd"
                        style={{ background: s.wired ? display.accent : "#5f7a77" }}
                      />
                      {s.id.toUpperCase()}
                      {s.wired ? "" : " · not wired yet"}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <div className="ge-empty">
                <b>Systems not wired yet.</b>
                <br />
                Nodes light up here as each system starts publishing.
              </div>
            )}
          </section>

          <section className="ge-stats" aria-label="Scoreboard">
            <div className="ge-stat">
              <b>{feed ? shippedCount : "—"}</b>
              <span>shipped · 7d</span>
            </div>
            <div className="ge-stat">
              <b>{feed ? todayCount : "—"}</b>
              <span>events · today</span>
            </div>
            <div className="ge-stat">
              <b>{feed ? `${wiredCount}/${systems.length}` : "—"}</b>
              <span>systems wired</span>
            </div>
          </section>

          <section className="ge-card" aria-label="Up next">
            <div className="ge-kicker">UP NEXT</div>
            {queue.length > 0 ? (
              <ul className="ge-queue">
                {queue.map((q, i) => (
                  <li className="ge-q" key={i}>
                    {q.waitingOnOwner && <span className="ge-tag">WAITING ON OWNER</span>}
                    <span>{q.label}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="ge-empty">
                <b>Queue clear.</b>
                <br />
                Nothing waiting — new work appears here first.
              </div>
            )}
          </section>

          <Link
            className="ge-fuel"
            href={`/${agent}`}
          >
            {agent === "danny" ? "Fuel the engine" : "Fuel the forge"}
          </Link>
          <div className="ge-note">
            Tips go to the {agent === "danny" ? "engine" : "forge"}&rsquo;s blockpage tip
            jar · 98% to the agent, 2% to the treasury
          </div>

          <footer className="ge-foot">
            {feed ? (
              <>
                Every event on this page is <b>real</b> — emitted by the engine,
                never simulated. Definitions: shipped = merges to production in the
                last 7 days · the wire runs ~5 minutes behind real time · client
                identities never appear here.
              </>
            ) : (
              <>
                This page is live but the feed isn&rsquo;t published yet — so it shows
                the honest empty state instead of invented activity.{" "}
                <b>Nothing here is simulated.</b>
              </>
            )}
          </footer>
        </div>
      </div>
    </div>
  );
}
