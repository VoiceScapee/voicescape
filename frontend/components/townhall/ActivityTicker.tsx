"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getJson } from "@/lib/townhall";

export interface ActivityItem {
  kind: "post" | "chat" | "proposal" | "vote" | "listing";
  text: string;
  author: string;
  ts: string;
  href: string;
}

const KIND_LABEL: Record<ActivityItem["kind"], string> = {
  post: "💬",
  chat: "💭",
  proposal: "🏛️",
  vote: "🗳️",
  listing: "🛒",
};

const POLL_MS = 20_000;

/**
 * ActivityTicker — the "living block" strip. Polls the cross-domain
 * activity feed every 20s and shows the latest happenings. Renders nothing
 * until the first successful load (and stays hidden if the feed is empty).
 */
export default function ActivityTicker() {
  const [items, setItems] = useState<ActivityItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const d = await getJson<{ items?: ActivityItem[] }>("/api/townhall/activity");
        if (!cancelled && Array.isArray(d.items)) setItems(d.items.slice(0, 6));
      } catch {
        // Best-effort; the ticker just stays as-is on failure.
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="th-ticker" aria-label="Live town hall activity">
      <span className="th-ticker-live">● live</span>
      <div className="th-ticker-items" role="marquee" aria-live="off">
        {items.map((it, i) => (
          <Link key={`${it.kind}-${it.ts}-${i}`} href={it.href} className="th-ticker-item">
            <span aria-hidden="true">{KIND_LABEL[it.kind]}</span>{" "}
            <strong>@{it.author}</strong> {it.text}
          </Link>
        ))}
      </div>
    </div>
  );
}
