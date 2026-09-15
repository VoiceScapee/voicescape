"use client";

/**
 * Community pulse — three real on-chain numbers for the landing page.
 *
 * (a) blockpages registered on chain and (b) tips settled on chain come from
 * /api/chain/stats (official Hedera mainnet mirror node, 15-min server
 * cache); (c) the 98% creator share is the fixed on-chain split (static).
 * Every stat carries the LIVE badge because the numbers are real.
 *
 * Honesty contract: while loading, show an honest shimmer skeleton with "—"
 * (never invented numbers); on error, the whole strip disappears — the page
 * never fabricates numbers.
 */
import { useEffect, useState } from "react";
import { T } from "@/components/T";
import { useLanguage } from "@/lib/i18n/LanguageContext";

interface ChainStats {
  pages: number | null;
  tips: number | null;
}

function Stat({
  value,
  labelKey,
  loading,
}: {
  value: string;
  labelKey: "landing.pulsePages" | "landing.pulseTips" | "landing.pulseShare";
  loading: boolean;
}) {
  return (
    <div className="vs-card vs-stat" style={{ padding: "18px 14px" }}>
      <span className="vs-stat-live">
        <span className="vs-stat-live-dot" aria-hidden="true" />
        <T k="landing.liveBadge" />
      </span>
      <div
        className={`vs-mono${loading ? " vs-anim-shimmer" : ""}`}
        style={{ fontSize: 24, fontWeight: 700 }}
      >
        {loading ? "—" : value}
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--vs-muted)",
          marginTop: 4,
          lineHeight: 1.4,
        }}
      >
        <T k={labelKey} />
      </div>
    </div>
  );
}

export function ChainPulseStats() {
  const { lang } = useLanguage();
  const [stats, setStats] = useState<ChainStats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/chain/stats", { cache: "no-store" });
        if (!res.ok) {
          if (alive) setFailed(true);
          return;
        }
        const json = (await res.json()) as ChainStats;
        if (alive) {
          // nulls mean the mirror read failed server-side — hide the strip.
          if (json.pages == null || json.tips == null) setFailed(true);
          else setStats(json);
        }
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);

  // Error: hide the stat strip entirely. Never fabricate numbers.
  if (failed) return null;

  const loading = stats === null;
  const fmt = (n: number): string => {
    try {
      return new Intl.NumberFormat(lang).format(n);
    } catch {
      return String(n);
    }
  };
  // stats only set when both lanes are non-null (nulls → failed → hidden).
  const pagesValue = stats && stats.pages != null ? fmt(stats.pages) : "—";
  const tipsValue = stats && stats.tips != null ? fmt(stats.tips) : "—";

  return (
    <section className="vs-section" style={{ paddingTop: 0 }}>
      <p className="vs-label">
        <T k="landing.pulseLabel" />
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
        }}
      >
        <Stat
          value={pagesValue}
          labelKey="landing.pulsePages"
          loading={loading}
        />
        <Stat
          value={tipsValue}
          labelKey="landing.pulseTips"
          loading={loading}
        />
        <Stat
          value="98%"
          labelKey="landing.pulseShare"
          loading={loading}
        />
      </div>
    </section>
  );
}
