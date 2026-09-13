"use client";

/**
 * Community pulse — the reason to come back.
 *
 * Leads with FREE (McLaren collectibles + testnet faucet, verified), then
 * featured video clips (curated official Hedera videos) and auto-updating
 * Hedera headlines from /api/pulse. Expired drops never show as claimable.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { T } from "@/components/T";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { FREEBIES, SHOWCASE } from "@/lib/landing/freebies";
import type { PulseItem } from "@/lib/server/rss";

interface PulseResponse {
  updatedAt: string | null;
  items: PulseItem[];
}

function isLive(endsAt: string | null): boolean {
  if (!endsAt) return true;
  return Date.now() < Date.parse(endsAt);
}

function fmtDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export function CommunityPulse() {
  const { t, lang } = useLanguage();
  const [data, setData] = useState<PulseResponse | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/pulse", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as PulseResponse;
        if (alive) setData(json);
      } catch {
        /* headlines stay hidden — the free shelf still shows */
      }
    };
    void load();
    const id = setInterval(load, 15 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const videos = (data?.items ?? []).filter((i) => i.kind === "video").slice(0, 3);
  const articles = (data?.items ?? []).filter((i) => i.kind !== "video").slice(0, 6);

  return (
    <section className="vs-section" style={{ paddingTop: 0 }} id="pulse">
      <p className="vs-label" style={{ textAlign: "center" }}>
        <span className="vs-live-dot" aria-hidden="true" /> <T k="landing.pulseLabel" />
      </p>
      <h2
        style={{
          fontSize: "clamp(1.6rem, 4.5vw, 2.4rem)",
          margin: "12px 0 12px",
          textAlign: "center",
        }}
      >
        <T k="landing.pulseTitle" />
      </h2>
      <p
        style={{
          textAlign: "center",
          color: "var(--vs-muted)",
          fontSize: 16,
          maxWidth: 640,
          margin: "0 auto 32px",
          lineHeight: 1.7,
        }}
      >
        <T k="landing.pulseSub" />
      </p>

      {/* FREE shelf — leads the section */}
      <div className="vs-grid-2" style={{ marginBottom: 28 }}>
        {FREEBIES.map((f) => {
          const live = isLive(f.endsAt);
          return (
            <a
              key={f.id}
              href={f.url}
              target="_blank"
              rel="noopener noreferrer"
              className="vs-card"
              style={{ textDecoration: "none", color: "inherit", display: "block" }}
            >
              <span
                className="vs-badge"
                style={{
                  background: live ? "rgba(52,211,153,0.15)" : "rgba(145,168,255,0.12)",
                  color: live ? "var(--vs-green)" : "var(--vs-muted)",
                  border: "1px solid var(--vs-border)",
                  marginBottom: 12,
                  display: "inline-block",
                }}
              >
                {live ? <T k="landing.freeBadge" /> : <T k="landing.freeRotating" />}
              </span>
              <h3 style={{ margin: "0 0 8px", fontSize: 19 }}>{f.name}</h3>
              <p style={{ margin: "0 0 16px", color: "var(--vs-muted)", fontSize: 15, lineHeight: 1.7 }}>
                <T k={f.descKey} />
              </p>
              <span className="vs-btn vs-btn-primary" style={{ fontSize: 14 }}>
                <T k={live ? f.ctaKey : f.expiredCtaKey} />
              </span>
            </a>
          );
        })}
      </div>

      {/* Video clips */}
      {videos.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <h3 style={{ fontSize: 17, margin: "0 0 14px" }}>
            <T k="landing.clipsTitle" />
          </h3>
          <div className="vs-grid-3">
            {videos.map((v) => (
              <a
                key={v.url}
                href={v.url}
                target="_blank"
                rel="noopener noreferrer"
                className="vs-card"
                style={{ textDecoration: "none", color: "inherit", padding: 0, overflow: "hidden" }}
              >
                {v.thumb && (
                  <div style={{ position: "relative" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={v.thumb}
                      alt=""
                      loading="lazy"
                      style={{ width: "100%", display: "block", aspectRatio: "16/9", objectFit: "cover" }}
                    />
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 40,
                      }}
                    >
                      ▶
                    </span>
                  </div>
                )}
                <div style={{ padding: 16 }}>
                  <p style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.5 }}>{v.title}</p>
                  {v.date && (
                    <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--vs-muted)" }}>
                      {v.source} · {fmtDate(v.date, lang)}
                    </p>
                  )}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Headlines */}
      {articles.length > 0 && (
        <div className="vs-card" style={{ marginBottom: 28 }}>
          <h3 style={{ fontSize: 17, margin: "0 0 6px" }}>
            <T k="landing.headlinesTitle" />
          </h3>
          {data?.updatedAt && (
            <p style={{ fontSize: 13, color: "var(--vs-muted)", margin: "0 0 12px" }}>
              <T k="landing.headlinesUpdated" /> {fmtDate(data.updatedAt, lang)}
            </p>
          )}
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {articles.map((a) => (
              <li
                key={a.url}
                style={{
                  padding: "12px 0",
                  borderTop: "1px solid var(--vs-border)",
                }}
              >
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "inherit", textDecoration: "none", fontWeight: 600, fontSize: 15 }}
                >
                  {a.title}
                </a>
                {a.date && (
                  <span style={{ display: "block", fontSize: 13, color: "var(--vs-muted)", marginTop: 4 }}>
                    {a.source} · {fmtDate(a.date, lang)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Ecosystem showcase */}
      <div style={{ textAlign: "center" }}>
        <p style={{ color: "var(--vs-muted)", fontSize: 14, margin: "0 0 12px" }}>
          <T k="landing.showcaseLabel" />
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          {SHOWCASE.map((s) => (
            <Link
              key={s.name}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="vs-btn"
              style={{ fontSize: 14, textDecoration: "none" }}
              title={t(s.descKey)}
            >
              {s.name}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
