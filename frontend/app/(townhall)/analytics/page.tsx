"use client";

/**
 * Creator analytics dashboard — /analytics.
 *
 * Owner-only: the stats API requires a wallet session whose address owns
 * the username on-chain. Shows views, tips, referrals, badges, a 30-day
 * view chart, top-performing subjects (listings), and the referral card.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { T } from "@/components/T";
import { useSession } from "@/lib/session";
import { useWriteGate } from "@/components/townhall/useTownhall";
import ReferralCard from "@/components/townhall/ReferralCard";

interface DailyViews {
  date: string;
  views: number;
}

interface SubjectViews {
  subject: string;
  label: string | null;
  views: number;
}

interface CreatorStats {
  username: string;
  totalViews: number;
  viewsLast7d: number;
  viewsLast30d: number;
  daily: DailyViews[];
  topSubjects: SubjectViews[];
  totalTipsHbar: number;
  tipsCount: number;
  totalReferrals: number;
  badgesEarned: number;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="vs-card vs-stat" style={{ padding: 16, minWidth: 0 }}>
      <span className="vs-stat-live" aria-hidden="true">
        <span className="vs-stat-live-dot" />
        <T k="stats.liveInDapp" />
      </span>
      <div className="th-muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </div>
      <div className="vs-mono" style={{ fontSize: 30, fontWeight: 800, marginTop: 4, lineHeight: 1.1 }}>{value}</div>
      {sub && (
        <div className="th-muted" style={{ fontSize: 12, marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function ViewsChart({ daily }: { daily: DailyViews[] }) {
  const max = Math.max(1, ...daily.map((d) => d.views));
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 3,
          height: 120,
          padding: "8px 4px 0",
        }}
        role="img"
        aria-label={`Page views over the last ${daily.length} days`}
      >
        {daily.map((d) => (
          <div
            key={d.date}
            title={`${d.date}: ${d.views} view${d.views === 1 ? "" : "s"}`}
            style={{
              flex: 1,
              minWidth: 0,
              height: `${Math.max(d.views > 0 ? 6 : 2, (d.views / max) * 100)}%`,
              background:
                d.views > 0
                  ? "linear-gradient(180deg, var(--vs-accent, #7c5cff), var(--vs-accent-dim, #4a3791))"
                  : "var(--vs-border, #2a2a3d)",
              borderRadius: "3px 3px 0 0",
            }}
          />
        ))}
      </div>
      <div className="th-muted" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 6 }}>
        <span>{daily[0]?.date.slice(5)}</span>
        <span>{daily[Math.floor(daily.length / 2)]?.date.slice(5)}</span>
        <span>{daily[daily.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { username, isAuthenticated, sessionReady } = useWriteGate();
  // SessionProvider is mounted at the root layout; degrade gracefully if absent.
  let session: ReturnType<typeof useSession> | null = null;
  try {
    session = useSession();
  } catch {
    session = null;
  }
  const [stats, setStats] = useState<CreatorStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionReady || !isAuthenticated || !username || !session) return;
    let live = true;
    setLoading(true);
    setError(null);
    fetch(`/api/analytics/stats?username=${encodeURIComponent(username)}`, {
      headers: { ...session.authHeader() },
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!live) return;
        if (!res.ok) {
          setError(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
          setStats(null);
        } else {
          setStats(body as unknown as CreatorStats);
        }
      })
      .catch(() => {
        if (live) {
          setError("Could not load analytics — check your connection and retry.");
          setStats(null);
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [sessionReady, isAuthenticated, username, session]);

  if (!sessionReady) {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 18px 72px" }}>
        <p className="th-muted">Loading…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 18px 72px" }}>
        <h1>📊 Analytics</h1>
        <p className="th-muted">
          Sign in with your wallet (top right) to see your creator analytics.
        </p>
      </div>
    );
  }

  if (!username) {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 18px 72px" }}>
        <h1>📊 Analytics</h1>
        <p className="th-muted">
          Set your page username to view analytics —{" "}
          <Link href="/builder" className="th-identity-link">
            no page yet? build one
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 18px 72px" }}>
      <h1>📊 Analytics</h1>
      <p className="th-muted" style={{ marginTop: -8 }}>
        How <Link href={`/${encodeURIComponent(username)}`} className="th-identity-name">@{username}</Link> is
        performing — only you can see this.
      </p>

      {loading && <p className="th-muted">Loading stats…</p>}
      {error && (
        <div className="vs-card" style={{ padding: 14, borderColor: "var(--vs-danger, #e5484d)" }}>
          <strong>Couldn&apos;t load analytics.</strong>
          <div className="th-muted" style={{ fontSize: 13, marginTop: 4 }}>{error}</div>
        </div>
      )}

      {stats && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 12,
              marginTop: 16,
            }}
          >
            <StatCard label="Views · 30d" value={String(stats.totalViews)} sub="counters keep 30 days" />
            <StatCard label="Views · 7d" value={String(stats.viewsLast7d)} />
            <StatCard label="Tips received" value={`${stats.totalTipsHbar} HBAR`} sub={`${stats.tipsCount} payment${stats.tipsCount === 1 ? "" : "s"} on-chain`} />
            <StatCard label="Referrals" value={String(stats.totalReferrals)} />
            <StatCard label="Badges" value={String(stats.badgesEarned)} />
          </div>

          <div className="vs-card" style={{ padding: 16, marginTop: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Views — last 30 days</div>
            <ViewsChart daily={stats.daily} />
          </div>

          <div className="vs-card" style={{ padding: 16, marginTop: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>🔥 Top performing</div>
            {stats.topSubjects.length === 0 ? (
              <p className="th-muted" style={{ fontSize: 13, margin: 0 }}>
                No listing views yet — share a marketplace listing and watch this space.
              </p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                {stats.topSubjects.map((s) => (
                  <li key={s.subject} className="th-row" style={{ justifyContent: "space-between", gap: 12 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.label ?? s.subject}
                    </span>
                    <span className="th-muted vs-mono" style={{ fontSize: 13, flexShrink: 0 }}>
                      {s.views} view{s.views === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div style={{ marginTop: 4 }}>
            <ReferralCard username={username} />
          </div>
        </>
      )}
    </div>
  );
}
