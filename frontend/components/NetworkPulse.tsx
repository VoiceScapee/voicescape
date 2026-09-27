"use client";

/**
 * NetworkPulse — the dapp-wide global pulse (heartbeat layer 1).
 *
 * A quiet chip in the site chrome (navbar + public blockpage header) that
 * pulses once per newly settled Hedera mainnet block — a radar ring
 * expands and fades on every block, the live block number ticks next to
 * it (including on phones), and a small "Xs ago" freshness readout makes
 * the liveness visceral for humans. The whole dapp breathes with the
 * chain. Mounted everywhere; never intrusive.
 *
 * Tapping the chip opens a plain-language explainer card — first-time
 * visitors learn what the number means instead of staring at a cryptic
 * "#100458020". No message content, no tracking, just the explainer.
 *
 * Polls the public mirror node directly from the browser
 * (GET /api/v1/blocks, ~8s while visible) — a few hundred bytes per call,
 * far under the mirror's per-IP limit. Pauses when the tab is hidden and
 * resyncs on return.
 *
 * Honesty: one real block = one pulse; catch-up gaps pulse per block
 * (never merged); big gaps resync silently; mirror errors go silent
 * (dim chip, backoff polling) until blocks resume. Reduced-motion users
 * get a static readout with zero animation. The "ago" readout derives
 * from the block's real consensus timestamp — never simulated.
 */

import { useEffect, useRef, useState } from "react";
import {
  MIRROR_BLOCKS_URL,
  PULSE_POLL_MS,
  PULSE_POLL_SILENT_MS,
  PULSE_STAGGER_MS,
  formatBlockAgo,
  formatBlockNumber,
  parseLatestBlockInfo,
  planBlockPulses,
  type BlockInfo,
} from "@/lib/network-pulse";

export default function NetworkPulse() {
  const [block, setBlock] = useState<BlockInfo | null>(null);
  const [silent, setSilent] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const lastBlockRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(false);
  const queueRef = useRef(0);
  const drainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    reducedMotionRef.current = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      setReducedMotion(e.matches);
      reducedMotionRef.current = e.matches;
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Tick the "Xs ago" freshness readout every 2s while visible.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setNowMs(Date.now());
    }, 2000);
    return () => clearInterval(id);
  }, []);

  // Close the explainer on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Drain the pulse queue: one motion per block, staggered so each is
  // perceptible. Never merged, never simulated.
  const scheduleDrain = () => {
    if (drainTimer.current !== null) return;
    const tickDrain = () => {
      if (!mountedRef.current) {
        drainTimer.current = null;
        return;
      }
      if (queueRef.current <= 0) {
        drainTimer.current = null;
        return;
      }
      queueRef.current -= 1;
      // Remounting the dot retriggers the ping animation exactly once.
      setPulseKey((k) => k + 1);
      drainTimer.current = setTimeout(tickDrain, PULSE_STAGGER_MS);
    };
    drainTimer.current = setTimeout(tickDrain, 0);
  };

  useEffect(() => {
    mountedRef.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const check = async (): Promise<boolean> => {
      let res: Response;
      try {
        res = await fetch(MIRROR_BLOCKS_URL, { cache: "no-store" });
      } catch {
        // Mirror unreachable: silent until blocks resume.
        if (!stopped) setSilent(true);
        return false;
      }
      // Throttled (429) or errored: silent, back off, keep watching.
      if (!res.ok) {
        if (!stopped) setSilent(true);
        return false;
      }
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        if (!stopped) setSilent(true);
        return false;
      }
      const info = parseLatestBlockInfo(data);
      if (info === null) {
        if (!stopped) setSilent(true);
        return false;
      }
      const plan = planBlockPulses(lastBlockRef.current, info.number);
      // The cursor only ever moves forward — a mirror rollback must not
      // re-arm pulses for blocks we already saw.
      if (lastBlockRef.current === null || info.number > lastBlockRef.current) {
        lastBlockRef.current = info.number;
      }
      if (stopped) return true;
      setBlock(info);
      setNowMs(Date.now());
      setSilent(false);
      if (plan.pulses > 0 && !reducedMotionRef.current) {
        queueRef.current += plan.pulses;
        scheduleDrain();
      }
      return true;
    };

    const loop = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        const ok = await check();
        failures = ok ? 0 : failures + 1;
      }
      if (stopped) return;
      timer = setTimeout(loop, failures > 0 ? PULSE_POLL_SILENT_MS : PULSE_POLL_MS);
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
      mountedRef.current = false;
      if (timer) clearTimeout(timer);
      if (drainTimer.current) clearTimeout(drainTimer.current);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chipLabel = silent
    ? "Hedera mainnet — reconnecting"
    : block === null
      ? "Hedera mainnet — connecting"
      : `Hedera mainnet · live · block ${block.number}`;

  const ago = block ? formatBlockAgo(block.timestampMs, nowMs) : null;

  return (
    <span className="vs-netpulse-wrap">
      <button
        type="button"
        className={`vs-netpulse${silent ? " is-silent" : ""}${open ? " is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          silent
            ? "Hedera mainnet connection silent, reconnecting. Tap to learn what this is."
            : block === null
              ? "Connecting to Hedera mainnet. Tap to learn what this is."
              : `Hedera mainnet live, block ${block.number}, ${ago} ago. Tap to learn what this is.`
        }
        title={chipLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span
          key={pulseKey}
          className={`vs-netpulse-dot${reducedMotion ? " is-static" : ""}`}
          aria-hidden="true"
        />
        <span className="vs-netpulse-label vs-mono" aria-hidden="true">
          {block === null ? (
            "mainnet"
          ) : (
            <>
              #{formatBlockNumber(block.number)}
              <span className="vs-netpulse-ago"> · {ago}</span>
            </>
          )}
        </span>
      </button>

      {open && (
        <>
          <span
            className="vs-netpulse-scrim"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <span
            className="vs-netpulse-card"
            role="dialog"
            aria-label="What is the live block number?"
          >
            <span className="vs-netpulse-card-head">
              <span
                className={`vs-netpulse-dot${reducedMotion ? " is-static" : ""}`}
                aria-hidden="true"
              />
              <strong>Hedera mainnet · live</strong>
              <button
                type="button"
                className="vs-netpulse-card-close"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </span>
            <p>
              That number is the latest block on the Hedera network — it ticks
              every few seconds because the chain never sleeps.
            </p>
            <p>
              Every tip and blockpage on Voicescape settles here. You&rsquo;re
              watching the network breathe.
            </p>
            {block && (
              <p className="vs-netpulse-card-block vs-mono">
                block #{formatBlockNumber(block.number)} · {ago} ago
              </p>
            )}
          </span>
        </>
      )}
    </span>
  );
}
