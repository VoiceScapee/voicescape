"use client";

/**
 * Fresh blockpages for the landing page.
 *
 * The most recently *published* blockpages on Voicescape, newest first,
 * read live from /api/landing/fresh (registry transactions on the mirror
 * node). New pages get discovered here and earn views. Cards link straight
 * to the page. Nothing published recently (or API unreachable) → renders
 * nothing.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { T } from "@/components/T";
import { useLanguage } from "@/lib/i18n/LanguageContext";

interface FreshPage {
  username: string;
  displayName: string;
  avatarEmoji: string | null;
  ownerType: number;
  registeredAt: number;
  pinned: boolean;
}

export function FreshBlockpages() {
  const [pages, setPages] = useState<FreshPage[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { t } = useLanguage();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/landing/fresh", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { pages?: FreshPage[] };
        if (alive && Array.isArray(json.pages) && json.pages.length > 0) {
          setPages(json.pages);
        }
      } catch {
        /* section stays hidden on failure */
      } finally {
        if (alive) setLoaded(true);
      }
    };
    void load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Honest loading state: shimmer skeleton reserves the section's space so
  // late-arriving cards don't shove content down (CLS). After load, empty/
  // error still hides the section entirely — never a dead box.
  if (!loaded) {
    return (
      <section className="vs-section" style={{ paddingTop: 0 }} aria-hidden="true">
        <p className="vs-label">
          <T k="landing.freshLabel" />
        </p>
        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          }}
        >
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="vs-glass vs-anim-shimmer"
              style={{ borderRadius: 14, padding: 18, minHeight: 120 }}
            />
          ))}
        </div>
      </section>
    );
  }

  if (!pages) return null;

  return (
    <section className="vs-section" style={{ paddingTop: 0 }}>
      <p className="vs-label">
        <T k="landing.freshLabel" />
      </p>
      <p style={{ color: "var(--vs-muted)", fontSize: 14, margin: "0 0 18px", lineHeight: 1.55 }}>
        <T k="landing.freshSub" />
      </p>
      <div
        style={{
          display: "grid",
          gap: 14,
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
        }}
      >
        {pages.map((p) => {
          const isAgent = p.ownerType === 1;
          return (
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
                  {p.avatarEmoji ?? (isAgent ? "🤖" : "🧑")}
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
                    @{p.username}
                  </div>
                </div>
                {!p.pinned && (
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: "0.08em",
                      padding: "4px 10px",
                      borderRadius: 999,
                      background: "#1f9d55",
                      color: "#fff",
                      flexShrink: 0,
                    }}
                  >
                    <T k="landing.freshNew" />
                  </span>
                )}
              </div>
              <div
                className="vs-mono"
                style={{ fontSize: 11, color: "var(--vs-muted)", display: "flex", gap: 8 }}
              >
                <span
                  style={{
                    padding: "3px 10px",
                    borderRadius: 999,
                    border: "1px solid var(--vs-border)",
                    background: "var(--vs-glass)",
                  }}
                >
                  {isAgent ? "🤖 " : "🧑 "}
                  <T k={isAgent ? "landing.freshAgent" : "landing.freshHuman"} />
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
