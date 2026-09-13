"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getJson } from "@/lib/townhall";
import BadgeRow from "@/components/townhall/BadgeRow";
import type { Badge } from "@/lib/server/townhall/badges";

interface LeaderEntry {
  username: string;
  wallet: string | null;
  score: number;
  badgeCount: number;
  topBadge: Badge | null;
}

interface MarketLeader {
  address: string;
  totalHbar: number;
  count: number;
}

interface MarketBoards {
  tippers: MarketLeader[];
  buyers: MarketLeader[];
  sellers: MarketLeader[];
  scannedAt: number;
}

const RANK_MEDAL = ["🥇", "🥈", "🥉"];

type Tab = "activity" | "tippers" | "buyers" | "sellers";

const TABS: { id: Tab; label: string }[] = [
  { id: "activity", label: "🏆 Activity" },
  { id: "tippers", label: "💸 Top Tippers" },
  { id: "buyers", label: "🛍️ Top Buyers" },
  { id: "sellers", label: "💼 Top Sellers" },
];

function shortAddress(a: string): string {
  return a.length > 13 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function fmtHbar(n: number): string {
  return n >= 100 ? Math.round(n).toString() : n.toFixed(n >= 1 ? 2 : 4);
}

function MarketBoard({
  leaders,
  unit,
  empty,
}: {
  leaders: MarketLeader[];
  unit: (l: MarketLeader) => string;
  empty: string;
}) {
  if (leaders.length === 0) {
    return <p style={{ opacity: 0.6 }}>{empty}</p>;
  }
  return (
    <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
      {leaders.map((l, i) => (
        <li
          key={l.address}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 14px",
            borderRadius: 12,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <span style={{ fontSize: 20, width: 32, textAlign: "center" }}>
            {i < 3 ? RANK_MEDAL[i] : `#${i + 1}`}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="vs-mono" style={{ fontWeight: 700, fontSize: 15 }} title={l.address}>
              {shortAddress(l.address)}
            </div>
            <div style={{ fontSize: 13, opacity: 0.65 }}>
              {fmtHbar(l.totalHbar)} HBAR · {unit(l)}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function LeaderboardClient() {
  const [tab, setTab] = useState<Tab>("activity");
  const [leaders, setLeaders] = useState<LeaderEntry[] | null>(null);
  const [boards, setBoards] = useState<MarketBoards | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getJson<{ leaders: LeaderEntry[] }>("/api/townhall/leaderboard")
      .then((d) => {
        if (live) setLeaders(d.leaders ?? []);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : "Failed to load leaderboard");
      });
    return () => {
      live = false;
    };
  }, []);

  // Market boards load lazily on first tab open — on-chain scan, cached 10 min.
  useEffect(() => {
    if (tab === "activity" || boards !== null) return;
    let live = true;
    getJson<MarketBoards>("/api/townhall/leaderboard/market")
      .then((d) => {
        if (live) {
          setBoards({
            tippers: d.tippers ?? [],
            buyers: d.buyers ?? [],
            sellers: d.sellers ?? [],
            scannedAt: d.scannedAt ?? 0,
          });
        }
      })
      .catch((e) => {
        if (live) setMarketError(e instanceof Error ? e.message : "Failed to load market boards");
      });
    return () => {
      live = false;
    };
  }, [tab, boards]);

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 18px 72px" }}>
      <h1 style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>🏆 Leaderboard</h1>
      <p style={{ opacity: 0.7, marginBottom: 16, fontSize: 14 }}>
        {tab === "activity"
          ? "Top town hall contributors by activity — chat, posts, rooms, listings, and reputation votes. Badges are earned, never bought."
          : "Ranked live from Hedera mainnet — every total is decoded from on-chain TipSent and PurchaseCompleted events. No estimates."}
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }} role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.12)",
              background: tab === t.id ? "rgba(255,255,255,0.12)" : "transparent",
              color: "inherit",
              fontSize: 14,
              fontWeight: tab === t.id ? 700 : 400,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "activity" && (
        <>
          {error && <p style={{ color: "#f87171" }}>{error}</p>}
          {leaders === null && !error && <p style={{ opacity: 0.6 }}>Loading…</p>}
          {leaders !== null && leaders.length === 0 && (
            <p style={{ opacity: 0.6 }}>No activity yet — be the first voice in the town hall.</p>
          )}

          <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {leaders?.map((l, i) => (
              <li
                key={l.username}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 14px",
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <span style={{ fontSize: 20, width: 32, textAlign: "center" }}>
                  {i < 3 ? RANK_MEDAL[i] : `#${i + 1}`}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Link
                    href={`/${l.username}`}
                    style={{ fontWeight: 700, fontSize: 16, textDecoration: "none", color: "inherit" }}
                  >
                    @{l.username}
                  </Link>
                  <div style={{ fontSize: 13, opacity: 0.65 }}>
                    {l.score} pts · {l.badgeCount} badge{l.badgeCount === 1 ? "" : "s"}
                  </div>
                  {l.topBadge && <BadgeRow badges={[l.topBadge]} />}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}

      {tab !== "activity" && (
        <>
          {marketError && <p style={{ color: "#f87171" }}>{marketError}</p>}
          {boards === null && !marketError && <p style={{ opacity: 0.6 }}>Scanning Hedera mainnet…</p>}
          {boards !== null && tab === "tippers" && (
            <MarketBoard
              leaders={boards.tippers}
              unit={(l) => `${l.count} tip${l.count === 1 ? "" : "s"} sent`}
              empty="No tips on-chain yet — be the first to tip a creator."
            />
          )}
          {boards !== null && tab === "buyers" && (
            <MarketBoard
              leaders={boards.buyers}
              unit={(l) => `${l.count} purchase${l.count === 1 ? "" : "s"}`}
              empty="No marketplace purchases on-chain yet — be the first buyer."
            />
          )}
          {boards !== null && tab === "sellers" && (
            <MarketBoard
              leaders={boards.sellers}
              unit={(l) => `${l.count} sale${l.count === 1 ? "" : "s"}`}
              empty="No marketplace sales on-chain yet — list something to be the first seller."
            />
          )}
        </>
      )}
    </div>
  );
}
