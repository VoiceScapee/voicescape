"use client";

/**
 * Blockchain Heartbeat — builder module #14 (universal live-connection).
 *
 * A hairline EKG trace + status dot + micro-mono readout on the page's
 * proof row. Two layered signals, never one fake pulse:
 *
 * 1. Liveness — the dot blinks once per successful data check (~10s).
 *    It says "this page is talking to the chain right now."
 * 2. Events — each REAL settled tip on the page's wallet (TipSent logs
 *    from the Tips contract, read via /api/heartbeat) draws ONE
 *    violet/mint EKG spike, amplitude scaled to the amount. An idle page
 *    shows a calm advancing line — quiet, never dead.
 *
 * Honesty rules (no exceptions):
 * - Every spike is one real on-chain event. NOTHING is synthesized.
 * - The readout names the source ("mirror") — never claims gossip-speed.
 * - Reduced-motion: a static "connected · mainnet" chip, zero animation.
 * - Settled events are announced once via a polite aria-live region;
 *   routine liveness checks are never announced.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getActiveChain } from "@/lib/chains";

export interface HeartbeatEvent {
  id: string;
  type: "tip";
  amountHbar: number;
  amountTinybar: string;
  ts: string;
  txHash: string | null;
}

interface HeartbeatResponse {
  ok: boolean;
  status: "ok" | "degraded" | "offline";
  wallet: string;
  cursor: string | null;
  checkedAt: number;
  cached: boolean;
  slow: boolean;
  events: HeartbeatEvent[];
}

type ConnState = "live" | "degraded" | "offline";

const POLL_VISIBLE_MS = 10_000;
const POLL_IDLE_MS = 30_000;
/** Ticks per second for the trace advance (20fps is plenty for a hairline). */
const TRACE_FPS = 20;
const TRACE_POINTS = 140;
/** Ticks a tip spike takes to draw across the trace. */
const SPIKE_TICKS = 30;

function spikeAmplitude(amountHbar: number): number {
  const a = 5 + Math.sqrt(Math.max(0, amountHbar)) * 4;
  return Math.min(18, Math.max(5, a));
}

/**
 * EKG-like spike waveform. p in [0,1): a small q dip, a tall R peak, a
 * deep S trough, a soft T bump, then settle. Returns a signed multiplier;
 * multiply by the amplitude and subtract from the baseline y (canvas y
 * grows downward, so positive = upward spike).
 */
function spikeWave(p: number): number {
  if (p < 0.12) return -0.15 * Math.sin((p / 0.12) * Math.PI);
  if (p < 0.32) {
    const q = (p - 0.12) / 0.2;
    return -0.15 + 1.5 * Math.sin(q * Math.PI);
  }
  if (p < 0.52) {
    const q = (p - 0.32) / 0.2;
    return 1.35 - 1.9 * Math.sin(q * Math.PI);
  }
  if (p < 0.78) {
    const q = (p - 0.52) / 0.26;
    return -0.55 + 0.75 * Math.sin(q * Math.PI);
  }
  const q = (p - 0.78) / 0.22;
  return 0.2 * (1 - q);
}

function formatHbar(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

const SCRAMBLE_CHARS = "!<>-_\\/[]{}=+*^?#";

/**
 * Decrypt-scramble text effect for the proof chips: on mount the label
 * resolves from random glyphs to its final text (~0.7s, staggered per
 * chip). Purely presentational — it never implies chain state. Disabled
 * under reduced motion (renders the final text immediately). The animated
 * text is aria-hidden; the real label is exposed via a sr-only span so
 * screen readers hear it once, cleanly.
 */
function useScramble(text: string, active: boolean, delayMs: number): string {
  const [out, setOut] = useState(text);
  useEffect(() => {
    if (!active) {
      setOut(text);
      return;
    }
    setOut("");
    let frame = 0;
    const total = 22;
    let id: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      id = setInterval(() => {
        frame += 1;
        const reveal = Math.floor((frame / total) * text.length);
        let s = text.slice(0, reveal);
        for (let i = reveal; i < text.length; i++) {
          s += text[i] === " " ? " " : SCRAMBLE_CHARS[(Math.random() * SCRAMBLE_CHARS.length) | 0];
        }
        setOut(s);
        if (frame >= total) {
          if (id) clearInterval(id);
          setOut(text);
        }
      }, 30);
    }, delayMs);
    return () => {
      clearTimeout(start);
      if (id) clearInterval(id);
    };
  }, [text, active, delayMs]);
  return out;
}

export default function HeartbeatBlock({
  owner,
  preview,
}: {
  /** Page owner's wallet (0.0.x or 0x…). Null in builder preview. */
  owner: string | null | undefined;
  /** Builder preview: never fetch — render the labeled simulated chip. */
  preview?: boolean;
}) {
  const chain = getActiveChain();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [conn, setConn] = useState<ConnState>("live");
  const [announcement, setAnnouncement] = useState("");
  const [blinkKey, setBlinkKey] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [lastTipAt, setLastTipAt] = useState<string | null>(null);

  const seenIds = useRef<Set<string>>(new Set());
  const firstPoll = useRef(true);
  const inViewport = useRef(true);
  const spike = useRef<{ startTick: number; amp: number } | null>(null);
  const tick = useRef(0);
  const connRef = useRef<ConnState>("live");
  connRef.current = conn;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Trace renderer: a rolling buffer advanced at TRACE_FPS. The calm line
  // is the liveness signal; spikes come ONLY from real settled events.
  useEffect(() => {
    if (reducedMotion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 200;
    const H = 30;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const mid = H / 2;
    const buf: number[] = new Array(TRACE_POINTS).fill(mid);
    let last = performance.now();
    let raf = 0;
    let t = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 1000 / TRACE_FPS) return;
      last = now;
      t += 1;
      tick.current = t;

      // Advance the trace by one sample.
      let y = mid + Math.sin(t / 9) * 1.3 + (Math.random() - 0.5) * 0.9;
      const sp = spike.current;
      if (sp) {
        const p = (t - sp.startTick) / SPIKE_TICKS;
        if (p >= 1) {
          spike.current = null;
        } else {
          y -= spikeWave(p) * sp.amp;
        }
      }
      buf.push(y);
      buf.shift();

      ctx.clearRect(0, 0, W, H);
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, "#a78bfa"); // violet — the 98% leg
      grad.addColorStop(1, "#5eead4"); // mint — the 2% leg
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.25;
      ctx.lineJoin = "round";
      ctx.globalAlpha = connRef.current === "offline" ? 0.25 : 0.9;
      ctx.beginPath();
      buf.forEach((v, i) => {
        const x = (i / (TRACE_POINTS - 1)) * W;
        if (i === 0) ctx.moveTo(x, v);
        else ctx.lineTo(x, v);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion]);

  const poll = useCallback(async () => {
    if (!owner) return;
    let res: Response;
    try {
      res = await fetch(`/api/heartbeat?wallet=${encodeURIComponent(owner)}`, {
        cache: "no-store",
      });
    } catch {
      setConn("offline");
      return;
    }
    if (!res.ok) {
      setConn("offline");
      return;
    }
    const data = (await res.json()) as HeartbeatResponse;
    setConn(data.status === "ok" ? "live" : data.status);
    // The dot blinks once per successful check — the liveness signal.
    setBlinkKey((k) => k + 1);

    const fresh: HeartbeatEvent[] = [];
    for (const e of data.events ?? []) {
      if (!e || typeof e.id !== "string" || seenIds.current.has(e.id)) continue;
      seenIds.current.add(e.id);
      fresh.push(e);
    }
    if (firstPoll.current) {
      // History on load is context, not news — mark seen, never spike.
      firstPoll.current = false;
      if (fresh.length > 0) setLastTipAt(fresh[fresh.length - 1].ts);
      return;
    }
    for (const e of fresh) {
      if (e.type === "tip") {
        // ONE real event = ONE spike. Amplitude ∝ amount, clamped.
        spike.current = { startTick: tick.current, amp: spikeAmplitude(e.amountHbar) };
        setLastTipAt(e.ts);
        // Polite announcement for settled events only — never for
        // routine liveness checks.
        setAnnouncement(
          `Tip of ${formatHbar(e.amountHbar)} HBAR settled on Hedera mainnet.`,
        );
      }
    }
  }, [owner]);

  // Polling cadence: ~10s while the heartbeat is on screen, ~30s when the
  // tab is visible but the heartbeat is off-screen, paused when hidden.
  // Reduced motion: exactly one honest check on mount, then the static chip.
  useEffect(() => {
    if (!owner) return;
    if (reducedMotion) {
      poll();
      return;
    }
    const el = wrapRef.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const obs =
      typeof IntersectionObserver !== "undefined" && el
        ? new IntersectionObserver(
            (entries) => {
              inViewport.current = entries.some((e) => e.isIntersecting);
            },
            { threshold: 0.1 },
          )
        : null;
    if (obs && el) obs.observe(el);

    const loop = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        await poll();
      }
      if (stopped) return;
      const delay =
        document.visibilityState === "visible" && inViewport.current
          ? POLL_VISIBLE_MS
          : POLL_IDLE_MS;
      timer = setTimeout(loop, delay);
    };
    loop();
    const onVis = () => {
      if (document.visibilityState === "visible" && !stopped) {
        if (timer) clearTimeout(timer);
        loop();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
      obs?.disconnect();
    };
  }, [owner, reducedMotion, poll]);

  const readout =
    conn === "live"
      ? "live · hedera mainnet · mirror"
      : conn === "degraded"
        ? "syncing · mirror slow"
        : "offline — reconnecting";

  // Builder preview without a wallet: an explicitly labeled simulation.
  // Never presented as chain truth.
  const scrambleActive = !reducedMotion;
  const registryLabel = useScramble("Registry", scrambleActive, 0);
  const tipsLabel = useScramble("Tips 98/2", scrambleActive, 150);
  const mainnetLabel = useScramble("Hedera mainnet", scrambleActive, 300);
  if (preview && !owner) {
    return (
      <section className="pv-block pv-heartbeat" aria-label="Blockchain heartbeat (simulated preview)">
        <div className="pv-hb-row">
          <span className="pv-hb-dot is-live" aria-hidden="true" />
          <span className="pv-hb-readout vs-mono">preview · simulated</span>
        </div>
      </section>
    );
  }
  if (!owner) return null;

  // Reduced motion: exactly one honest check on mount, then the static
  // chip — zero animation, zero polling.
  if (reducedMotion) {
    return (
      <section className="pv-block pv-heartbeat" aria-label="Blockchain heartbeat">
        <div className="pv-hb-row">
          <span
            className={`pv-hb-dot ${conn === "offline" ? "is-offline" : "is-live"}`}
            aria-hidden="true"
          />
          <span className="pv-hb-readout vs-mono">
            {conn === "offline" ? "offline — reconnecting" : "connected · mainnet"}
          </span>
        </div>
      </section>
    );
  }

  const explorer = chain.blockExplorer;
  const proofChips: { label: string; scrambled: string; href: string }[] = [
    { label: "Registry", scrambled: registryLabel, href: `${explorer}/contract/0.0.10854058` },
    { label: "Tips 98/2", scrambled: tipsLabel, href: `${explorer}/contract/0.0.10854060` },
    { label: "Hedera mainnet", scrambled: mainnetLabel, href: `${explorer}/` },
  ];
  return (
    <section className="pv-block pv-heartbeat" aria-label="Blockchain heartbeat">
      {/* Proof chips: the on-chain facts this heartbeat watches. */}
      <div className="pv-hb-chips" aria-label="On-chain proof">
        {proofChips.map((c) => (
          <a key={c.label} className="pv-hb-chip vs-mono" href={c.href} target="_blank" rel="noreferrer">
            <span className="pv-sr-only">{c.label}</span>
            <span aria-hidden="true">{c.scrambled}</span>
          </a>
        ))}
      </div>

      <div className="pv-hb-row" ref={wrapRef}>
        <span
          key={blinkKey}
          className={`pv-hb-dot ${
            conn === "live" ? "is-live" : conn === "degraded" ? "is-degraded" : "is-offline"
          } pv-hb-blink`}
          aria-hidden="true"
        />
        <canvas
          ref={canvasRef}
          className="pv-hb-trace"
          role="img"
          aria-label={
            conn === "live"
              ? "Live EKG trace of settled on-chain events for this page"
              : readout
          }
        />
        <span className="pv-hb-readout vs-mono" aria-hidden="true">
          {readout}
        </span>
        {/* Screen-reader status: the readout text without the canvas noise. */}
        <span className="pv-sr-only" role="status">
          {readout}
          {lastTipAt ? `. Last settled tip at ${lastTipAt}.` : ""}
        </span>
      </div>

      {/* Settled events are announced politely, once each. */}
      <span className="pv-sr-only" aria-live="polite">
        {announcement}
      </span>

      <a className="pv-hb-effects" href="/builder">
        effects by Voicescape
      </a>
    </section>
  );
}
