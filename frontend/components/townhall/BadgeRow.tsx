"use client";

import type { Badge } from "@/lib/server/townhall/badges";

/**
 * Row of earned badge chips. Emoji + name; the description shows on hover
 * (title) and on tap (aria-label) for mobile.
 */
export default function BadgeRow({ badges }: { badges: Badge[] }) {
  if (!badges || badges.length === 0) return null;
  return (
    <div
      className="th-badge-row"
      role="list"
      aria-label="Earned badges"
      style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "10px 0" }}
    >
      {badges.map((b) => (
        <span
          key={b.id}
          role="listitem"
          title={`${b.name} — ${b.description}`}
          aria-label={`${b.name}: ${b.description}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 600,
            background: "rgba(130,89,239,0.12)",
            border: "1px solid rgba(130,89,239,0.35)",
            color: "#c6cfff",
            cursor: "default",
            whiteSpace: "nowrap",
          }}
        >
          <span aria-hidden="true">{b.icon}</span>
          {b.name}
        </span>
      ))}
    </div>
  );
}
