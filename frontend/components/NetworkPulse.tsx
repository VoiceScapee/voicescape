"use client";

/**
 * NetworkPulse — the dapp-wide global pulse (heartbeat layer 1).
 *
 * A quiet dot in the site chrome (navbar + public blockpage header) that
 * pulses once per newly settled Hedera mainnet block. The whole dapp
 * breathes with the chain. Mounted everywhere; never intrusive.
 *
 * Polls the public mirror node directly from the browser
 * (GET /api/v1/blocks, ~8s while visible) — a few hundred bytes per call,
 * far under the mirror's per-IP limit. Pauses when the tab is hidden and
 * resyncs on return.
 *
 * Honesty: one real block = one pulse; catch-up gaps pulse per block
 * (never merged); big gaps resync silently; mirror errors go silent
 * (dim dot, backoff polling) until blocks resume. Reduced-motion users
 * get a static block-number readout with zero animation.
 */

import { useEffect, useRef, useState } from "react";
import {
  MIRROR_BLOCKS_URL,
  PULSE_POLL_MS,
  PULSE_POLL_SILENT_MS,
  PULSE_STAGGER_MS,
  parseLatestBlock,
  planBlockPulses,
} from "@/lib/network-pulse";

export default function NetworkPulse() {
  const [lastBlock, setLastBlock] = useState<number | null>(null);
  const [silent, setSilent] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);

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
      const latest = parseLatestBlock(data);
      if (latest === null) {
        if (!stopped) setSilent(true);
        return false;
      }
      const plan = planBlockPulses(lastBlockRef.current, latest);
      // The cursor only ever moves forward — a mirror rollback must not
      // re-arm pulses for blocks we already saw.
      if (lastBlockRef.current === null || latest > lastBlockRef.current) {
        lastBlockRef.current = latest;
      }
      if (stopped) return true;
      setLastBlock(latest);
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

  const stateLabel = silent
    ? "Hedera mainnet — reconnecting"
    : lastBlock === null
      ? "Hedera mainnet — connecting"
      : `Hedera mainnet · block ${lastBlock}`;

  return (
    <span
      className={`vs-netpulse${silent ? " is-silent" : ""}`}
      role="img"
      aria-label={
        silent
          ? "Hedera mainnet connection silent, reconnecting"
          : lastBlock === null
            ? "Connecting to Hedera mainnet"
            : `Hedera mainnet live, block ${lastBlock}`
      }
      title={stateLabel}
    >
      <span
        key={pulseKey}
        className={`vs-netpulse-dot${reducedMotion ? " is-static" : ""}`}
        aria-hidden="true"
      />
      <span className="vs-netpulse-label vs-mono" aria-hidden="true">
        {lastBlock === null ? "mainnet" : `#${lastBlock}`}
      </span>
    </span>
  );
}
