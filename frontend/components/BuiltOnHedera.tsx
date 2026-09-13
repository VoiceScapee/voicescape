import { T } from "./T";

/**
 * Trademark-compliant "Built on Hedera" footer lockup.
 *
 * - Uses the official Hedera logo asset from Hedera's brand library
 *   (white reverse on dark, ™ baked into the mark) — never redrawn.
 * - The Hedera mark is subordinate: smaller than the Voicescape identity,
 *   never adjacent to or bolder than the Voicescape name, and never
 *   incorporated into Voicescape's name or logo.
 * - Written "Built on" text needs no ™ (per Hedera's brand policy); the
 *   asset itself carries the ™.
 * - Carries the required non-affiliation disclaimer.
 */
export default function BuiltOnHedera() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        marginTop: 20,
      }}
    >
      <a
        href="https://hedera.com"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Built on Hedera"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          textDecoration: "none",
          color: "var(--vs-muted)",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>Built on</span>
        <img
          src="/hedera-logo.svg"
          alt="Hedera"
          width={86}
          height={24}
          draggable={false}
          style={{ display: "block", height: 18, width: "auto", userSelect: "none" }}
        />
      </a>
      <p
        style={{
          margin: 0,
          fontSize: 11,
          lineHeight: 1.6,
          color: "var(--vs-muted)",
          opacity: 0.8,
          maxWidth: 560,
        }}
      >
        <T k="landing.hederaDisclaimer" />
      </p>
    </div>
  );
}
