"use client";

/**
 * Platform Founder badge. Shown on founder pages (see lib/founders.ts) so
 * visitors know this page belongs to the Voicescape team. Purely visual —
 * it confers no on-chain rights and is not user-editable.
 */
export default function FounderBadge() {
  return (
    <span
      className="pv-founder-badge"
      role="img"
      title="Voicescape Founder"
      aria-label="Voicescape Founder"
    >
      <span aria-hidden="true">👑</span>
      <span>Founder</span>
    </span>
  );
}
