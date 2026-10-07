"use client";

import type { Badge } from "@/lib/server/townhall/badges";

/**
 * Row of earned badge chips. Emoji + name; the description shows on hover
 * (title) and on tap (aria-label) for mobile.
 *
 * Purchased badges (category "purchased") get an amber treatment so owned
 * items are visually distinct from earned achievement/referral badges.
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
      {badges.map((b) => {
        const isPurchased = b.category === "purchased";
        return (
          <span
            key={b.id}
            role="listitem"
            title={`${b.name} — ${b.description}`}
            aria-label={`${b.name}: ${b.description}`}
            data-category={b.category}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              background: isPurchased ? "rgba(255,193,7,0.12)" : "rgba(130,89,239,0.12)",
              border: isPurchased ? "1px solid rgba(255,193,7,0.45)" : "1px solid rgba(130,89,239,0.35)",
              color: isPurchased ? "#ffe1a1" : "#c6cfff",
              cursor: "default",
              whiteSpace: "nowrap",
            }}
          >
            <span aria-hidden="true">{b.icon}</span>
            {b.name}
            {isPurchased && (
              <span
                aria-hidden="true"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  opacity: 0.75,
                }}
              >
                Owned
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
