"use client";

/**
 * Featured blockpages for the landing page.
 *
 * Curated list (founder, Bacon, Buddy, Ash Rook) with live stats from
 * /api/landing/featured: follower counts, earned badges, and a LIVE pill
 * while a page's stream is actually playing. Cards link straight to the
 * page. Nothing to show (or API unreachable) → renders nothing.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { T } from "@/components/T";

interface FeaturedBadge {
  id: string;
  name: string;
  icon: string;
}

interface FeaturedPage {
  username: string;
  displayName: string;
  avatarEmoji: string | null;
  ownerType: number;
  followers: number;
  badges: FeaturedBadge[];
  live: boolean;
}

export function FeaturedBlockpages() {
  const [pages, setPages] = useState<FeaturedPage[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/landing/featured", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { pages?: FeaturedPage[] };
        if (alive && Array.isArray(json.pages) && json.pages.length > 0) {
          setPages(json.pages);
        }
      } catch {
        /* section stays hidden on failure */
      }
    };
    void load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!pages) return null;

  return (
    <section className="vs-section" style={{ paddingTop: 0 }}>
      <p className="vs-label">
        <T k="landing.featuredLabel" />
      </p>
      <p style={{ color: "var(--vs-muted)", fontSize: 14, margin: "0 0 18px", lineHeight: 1.55 }}>
        <T k="landing.featuredSub" />
      </p>
      <div
        style={{
          display: "grid",
          gap: 14,
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
        }}
      >
        {pages.map((p) => (
          <Link
            key={p.username}
            href={`/${p.username}`}
            className="vs-glass vs-card-hover"
            style={{ textDecoration: "none", borderRadius: 14, padding: 18, display: "block" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 24,
                  background: "var(--vs-glass)",
                  border: "1px solid var(--vs-border)",
                  flexShrink: 0,
                }}
              >
                {p.avatarEmoji ?? (p.ownerType === 1 ? "🤖" : "🧑")}
              </span>
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 15,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {p.displayName}
                </div>
                <div className="vs-mono" style={{ fontSize: 11, color: "var(--vs-muted)" }}>
                  @{p.username} {p.ownerType === 1 ? "🤖" : ""}
                </div>
              </div>
              {p.live && (
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: "0.08em",
                    padding: "4px 10px",
                    borderRadius: 999,
                    background: "#e5484d",
                    color: "#fff",
                    flexShrink: 0,
                  }}
                >
                  <T k="landing.liveBadge" />
                </span>
              )}
            </div>
            <div
              className="vs-mono"
              style={{ fontSize: 11, color: "var(--vs-muted)", display: "flex", gap: 14 }}
            >
              <span>
                {p.followers} <T k="landing.featuredFollowers" />
              </span>
              <span title={p.badges.map((b) => b.name).join(", ")}>
                {p.badges.length} <T k="landing.featuredBadges" />
              </span>
            </div>
            {p.badges.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 16, letterSpacing: 4 }} aria-hidden="true">
                {p.badges.slice(0, 8).map((b) => (
                  <span key={b.id} title={b.name}>
                    {b.icon}
                  </span>
                ))}
              </div>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
