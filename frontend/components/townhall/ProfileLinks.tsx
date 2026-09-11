"use client";

import { useEffect, useState } from "react";
import { getJson } from "@/lib/townhall";
import type { ProfileLinksView } from "@/lib/server/townhall/types";

/**
 * Cross-platform identity links ("Find me elsewhere") for a Voicescape
 * page. Fetches the public profile-links API and renders safe external
 * links. Values that look like URLs become links; bare handles are shown
 * as text (no guessed URLs — we don't invent destinations).
 */
function asHref(value: string): string | null {
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) return v;
  return null;
}

const PLATFORM_LABELS: Record<string, string> = {
  twitter: "𝕏 / Twitter",
  x: "𝕏 / Twitter",
  github: "GitHub",
  website: "Website",
  farcaster: "Farcaster",
  discord: "Discord",
  telegram: "Telegram",
  youtube: "YouTube",
  lens: "Lens",
};

function labelFor(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}

export default function ProfileLinks({ username }: { username: string }) {
  const [view, setView] = useState<ProfileLinksView | null>(null);

  useEffect(() => {
    let live = true;
    getJson<ProfileLinksView>(`/api/townhall/profile-links?username=${encodeURIComponent(username)}`)
      .then((d) => {
        if (live) setView(d);
      })
      .catch(() => {
        if (live) setView({ username, links: {}, ts: "" });
      });
    return () => {
      live = false;
    };
  }, [username]);

  const entries = view ? Object.entries(view.links) : [];
  if (entries.length === 0) return null;

  return (
    <div className="th-profile-links" style={{ marginTop: 12 }}>
      <div className="th-muted" style={{ fontSize: 13, marginBottom: 6 }}>
        Find me elsewhere
      </div>
      <div className="th-row" style={{ gap: 8, flexWrap: "wrap" }}>
        {entries.map(([platform, value]) => {
          const href = asHref(value);
          return href ? (
            <a
              key={platform}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="vs-btn vs-btn-ghost th-btn-sm"
            >
              {labelFor(platform)}
            </a>
          ) : (
            <span key={platform} className="th-badge" title={value}>
              {labelFor(platform)}: {value}
            </span>
          );
        })}
      </div>
    </div>
  );
}
