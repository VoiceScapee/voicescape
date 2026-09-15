"use client";

/**
 * Hedera headlines — four cards for the landing page, streamed from
 * /api/pulse: 2 from the Hedera-blog lane + 2 from the crypto-press lane.
 *
 * The pulse route classifies articles by source ("Hedera Blog" vs the
 * crypto outlets) but doesn't expose the lane field; the classification is
 * re-derived here from the source name. Curated video clips (kind:
 * "video") are excluded — this section is headlines only.
 *
 * Refreshes every 15 minutes (same client-poll pattern as the rest of the
 * pulse surface). Hides entirely when the feed yields nothing.
 */
import { useEffect, useState } from "react";
import ExternalLink from "@/components/ExternalLink";
import { T } from "@/components/T";
import type { PulseItem } from "@/lib/server/rss";

interface PulseResponse {
  updatedAt: string | null;
  items: PulseItem[];
}

const HEDERA_BLOG_SOURCE = "Hedera Blog";
const PER_LANE = 2;

interface Headline {
  source: string;
  title: string;
  url: string;
}

function pickHeadlines(items: PulseItem[]): Headline[] {
  const articles = items.filter((i) => i.kind === "article" && i.title && i.url);
  const hedera = articles
    .filter((i) => i.source === HEDERA_BLOG_SOURCE)
    .slice(0, PER_LANE);
  const crypto = articles
    .filter((i) => i.source !== HEDERA_BLOG_SOURCE)
    .slice(0, PER_LANE);
  return [...hedera, ...crypto].map((i) => ({
    source: i.source,
    title: i.title,
    url: i.url,
  }));
}

export function Headlines() {
  const [headlines, setHeadlines] = useState<Headline[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/pulse", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as PulseResponse;
        if (alive && Array.isArray(json.items)) {
          setHeadlines(pickHeadlines(json.items));
        }
      } catch {
        /* section stays hidden when the feed is unreachable */
      }
    };
    void load();
    const id = setInterval(load, 15 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!headlines || headlines.length === 0) return null;

  return (
    <section className="vs-section" style={{ paddingTop: 0 }}>
      <style>{`
        .vs-headlines-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        @media (min-width: 700px) { .vs-headlines-grid { grid-template-columns: repeat(4, 1fr); } }
      `}</style>
      <p className="vs-label">
        <T k="landing.headlinesLabel" />
      </p>
      <div className="vs-headlines-grid">
        {headlines.map((h) => (
          <ExternalLink
            key={h.url}
            href={h.url}
            className="vs-glass"
            style={{
              borderRadius: 14,
              padding: 16,
              textDecoration: "none",
              color: "inherit",
              display: "block",
            }}
          >
            <span
              className="vs-mono"
              style={{
                fontSize: 10,
                letterSpacing: "0.08em",
                color: "#c8d1ff",
                textTransform: "uppercase",
              }}
            >
              {h.source}
            </span>
            <p style={{ fontSize: 14, lineHeight: 1.5, margin: "8px 0 0" }}>
              {h.title}
            </p>
          </ExternalLink>
        ))}
      </div>
    </section>
  );
}
