interface LogoProps {
  size?: number;
  withWordmark?: boolean;
}

/**
 * Voicescape mark: a hexagonal node with a violet→cyan gradient and two
 * orbiting dots, plus an optional gradient wordmark.
 */
export default function Logo({ size = 32, withWordmark = true }: LogoProps) {
  const gid = "vs-logo-grad";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        lineHeight: 1,
        userSelect: "none",
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        role="img"
        aria-label="Voicescape logo"
      >
        <defs>
          <linearGradient id={gid} x1="8" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#8b5cf6" />
            <stop offset="1" stopColor="#22d3ee" />
          </linearGradient>
        </defs>
        {/* hexagon */}
        <path
          d="M24 4 40 13.2v17.6L24 44 8 30.8V13.2L24 4Z"
          stroke={`url(#${gid})`}
          strokeWidth="2.6"
          strokeLinejoin="round"
        />
        {/* inner node */}
        <circle cx="24" cy="24" r="4.6" fill={`url(#${gid})`} />
        {/* spokes */}
        <path
          d="M24 24 13.5 15.5M24 24l10.5-8.5M24 24l-1 13M24 24l9.6 8.6"
          stroke={`url(#${gid})`}
          strokeWidth="1.6"
          strokeLinecap="round"
          opacity="0.85"
        />
        {/* orbiting dots */}
        <circle cx="11.5" cy="13" r="2.1" fill="#e879f9" />
        <circle cx="36" cy="35" r="2.1" fill="#22d3ee" />
      </svg>
      {withWordmark && (
        <span
          className="vs-gradient-text"
          style={{ fontSize: size * 0.68, fontWeight: 700, letterSpacing: "-0.01em" }}
        >
          Voicescape
        </span>
      )}
    </span>
  );
}
