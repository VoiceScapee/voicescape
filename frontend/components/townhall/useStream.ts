"use client";

import { useEffect, useRef, useState } from "react";

export type StreamConn = "connecting" | "live" | "polling" | "error";

/**
 * Parse `data:` lines out of an SSE text chunk (used by the polling
 * fallback, which reads the stream endpoint as plain text).
 */
export function parseSseLines<T>(text: string, isValid: (m: unknown) => m is T): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    try {
      const msg: unknown = JSON.parse(t.slice(5).trim());
      if (isValid(msg)) out.push(msg);
    } catch {
      // partial line — skip
    }
  }
  return out;
}

/**
 * useStreamEvents — live SSE subscription with a polling fallback.
 *
 * Mirrors the proven ChatRoomClient pattern: EventSource first, short-lived
 * fetch against the same endpoint every 5s when EventSource fails, plus a
 * 6s watchdog that switches to polling if the stream never opens.
 *
 * `onEvents` receives each parsed batch; the caller merges/dedupes.
 * Pass `url: null` to stay disconnected.
 */
export function useStreamEvents<T>(
  url: string | null,
  onEvents: (events: T[]) => void,
  isValid: (m: unknown) => m is T,
  opts?: { headers?: HeadersInit; dataKey?: string },
): StreamConn {
  const [conn, setConn] = useState<StreamConn>("connecting");
  const onEventsRef = useRef(onEvents);
  onEventsRef.current = onEvents;
  const isValidRef = useRef(isValid);
  isValidRef.current = isValid;
  const headersRef = useRef<HeadersInit | undefined>(opts?.headers);
  headersRef.current = opts?.headers;
  const dataKeyRef = useRef(opts?.dataKey ?? "messages");
  dataKeyRef.current = opts?.dataKey ?? "messages";

  useEffect(() => {
    if (!url) {
      setConn("error");
      return;
    }
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let connState: StreamConn = "connecting";
    const set = (c: StreamConn) => {
      connState = c;
      if (!cancelled) setConn(c);
    };
    const handle = (events: T[]) => {
      if (!cancelled && events.length > 0) onEventsRef.current(events);
    };

    const pollOnce = async () => {
      const ctrl = new AbortController();
      const killer = setTimeout(() => ctrl.abort(), 4500);
      try {
        // Polling fallback uses the JSON endpoint (URL without /stream),
        // not the SSE endpoint. The SSE endpoint keeps connections open
        // indefinitely, which breaks fetch-based polling (abort loses data).
        const pollUrl = url.replace(/\/stream(\?.*)?$/, "$1");
        const res = await fetch(pollUrl, {
          headers: { accept: "application/json", ...(headersRef.current ?? {}) },
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
        const data = (await res.json()) as Record<string, unknown>;
        const key = dataKeyRef.current;
        const messages = Array.isArray(data[key]) ? (data[key] as unknown[]) : [];
        handle(messages.filter(isValidRef.current));
      } catch {
        // Try again on the next tick.
      } finally {
        clearTimeout(killer);
      }
    };

    const startPolling = () => {
      if (cancelled || pollTimer) return;
      set("polling");
      pollOnce();
      pollTimer = setInterval(pollOnce, 5000);
    };

    try {
      es = new EventSource(url);
      es.onopen = () => {
        if (!cancelled) set("live");
      };
      es.onmessage = (ev) => {
        try {
          const msg: unknown = JSON.parse(ev.data);
          if (isValidRef.current(msg)) handle([msg]);
        } catch {
          // ignore malformed frames
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (!cancelled) startPolling();
      };
    } catch {
      startPolling();
    }

    // Safety net: if EventSource never opens within 6s, fall back to polling.
    const watchdog = setTimeout(() => {
      if (!cancelled && connState === "connecting") {
        es?.close();
        es = null;
        startPolling();
      }
    }, 6000);

    return () => {
      cancelled = true;
      clearTimeout(watchdog);
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
    // The callbacks are mirrored into refs; only the URL re-subscribes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return conn;
}
