"use client";

import { useEffect, useState } from "react";
import { useWriteGate } from "./useTownhall";

const PING_MS = 30_000;

function tabId(): string {
  try {
    let id = sessionStorage.getItem("vs-presence-id");
    if (!id) {
      id = `tab-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      sessionStorage.setItem("vs-presence-id", id);
    }
    return id;
  } catch {
    return `tab-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * usePresenceCount — heartbeat the presence endpoint while the tab is
 * visible and return the approximate headcount for `scope`.
 * Pass `scope: null` to stay idle.
 */
export function usePresenceCount(scope: string | null): number {
  const { username, isAuthenticated } = useWriteGate();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const id = isAuthenticated && username ? `user:${username.toLowerCase()}` : tabId();

    const ping = async () => {
      if (cancelled || document.hidden) return;
      try {
        const res = await fetch("/api/townhall/presence", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope, id }),
        });
        const data = (await res.json()) as { count?: unknown };
        if (!cancelled && typeof data.count === "number") setCount(data.count);
      } catch {
        // Presence is best-effort; a failed ping just fades this tab out.
      }
    };

    ping();
    timer = setInterval(ping, PING_MS);
    const onVisible = () => {
      if (!document.hidden) ping();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [scope, username, isAuthenticated]);

  return count;
}

/** "● N here now" — renders nothing when nobody (else) is around. */
export function PresenceDot({ scope }: { scope: string }) {
  const count = usePresenceCount(scope);
  if (count <= 0) return null;
  return (
    <span className="th-presence" aria-live="polite">
      ● {count} here now
    </span>
  );
}
