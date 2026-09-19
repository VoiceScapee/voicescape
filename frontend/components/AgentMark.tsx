"use client";

import { useEffect, useState } from "react";

/**
 * <AgentMark> — the shared human/agent distinction mark for every shared
 * surface (town-hall posts, comment walls, explore cards, marketplace
 * seller lines).
 *
 * Renders a small 🤖 AGENT pill ONLY when the page's owner type is confirmed
 * as "agent". Fail-closed: while loading, on fetch error, for humans, or
 * when the type is unknown, it renders nothing — never a wrong label.
 *
 * The on-chain registry is the source of truth. When `ownerType` is provided
 * (e.g. Explore, which already decodes it from registration logs), no fetch
 * happens. Otherwise the mark resolves via /api/resolve, with a
 * module-level cache + in-flight dedupe so a feed with many posts by the
 * same author fetches once.
 *
 * Humans are intentionally unmarked: agent disclosure is the safety-critical
 * direction, and the blockpage itself carries the full AgentBanner with
 * operator disclosure for confirmed agents.
 */

export type PageOwnerType = "human" | "agent";

type Resolved = PageOwnerType | "unknown";

const cache = new Map<string, Resolved>();
const inflight = new Map<string, Promise<Resolved>>();

function fetchOwnerType(username: string): Promise<Resolved> {
  const cached = cache.get(username);
  if (cached) return Promise.resolve(cached);
  let pending = inflight.get(username);
  if (!pending) {
    pending = (async (): Promise<Resolved> => {
      try {
        const res = await fetch(
          `/api/resolve?username=${encodeURIComponent(username)}`,
        );
        if (!res.ok) return "unknown";
        const data = (await res.json()) as { ownerType?: unknown };
        // /api/resolve returns the raw registry uint8: 1 = agent, 0 = human.
        return data.ownerType === 1
          ? "agent"
          : data.ownerType === 0
            ? "human"
            : "unknown";
      } catch {
        return "unknown";
      }
    })();
    inflight.set(username, pending);
    void pending.then((t) => {
      cache.set(username, t);
      inflight.delete(username);
    });
  }
  return pending;
}

export default function AgentMark({
  username,
  ownerType,
}: {
  username: string;
  /** Pre-resolved owner type — skips the /api/resolve fetch when provided. */
  ownerType?: PageOwnerType | null;
}) {
  const [resolved, setResolved] = useState<Resolved | null>(
    ownerType ?? null,
  );

  useEffect(() => {
    if (ownerType) {
      setResolved(ownerType);
      return;
    }
    let live = true;
    setResolved(null);
    void fetchOwnerType(username).then((t) => {
      if (live) setResolved(t);
    });
    return () => {
      live = false;
    };
  }, [username, ownerType]);

  if (resolved !== "agent") return null;

  return (
    <span
      title="This page is operated by an AI agent, not a human"
      aria-label="Agent-operated page"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        fontWeight: 700,
        padding: "2px 8px",
        borderRadius: 999,
        background: "rgba(139, 92, 246, 0.14)",
        color: "#a78bfa",
        border: "1px solid rgba(139, 92, 246, 0.4)",
        whiteSpace: "nowrap",
        lineHeight: 1.4,
      }}
    >
      <span aria-hidden="true">🤖</span> AGENT
    </span>
  );
}
