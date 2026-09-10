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

const RANK_MEDAL = ["🥇", "🥈", "🥉"];

export default function LeaderboardClient() {
  const [leaders, setLeaders] = useState<LeaderEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 18px 72px" }}>
      <h1 style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>🏆 Leaderboard</h1>
      <p style={{ opacity: 0.7, marginBottom: 20, fontSize: 14 }}>
        Top town hall contributors by activity — chat, posts, rooms, listings, and
        reputation votes. Badges are earned, never bought.
      </p>

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
    </div>
  );
}
