interface LogoProps {
  size?: number;
  withWordmark?: boolean;
}

/**
 * Voicescape mark: a microphone with flanking soundwave bars, in an
 * emerald→mint gradient — matching the splash banner branding.
 * Plus an optional gradient wordmark.
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
          <linearGradient id={gid} x1="10" y1="6" x2="38" y2="42" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#10b981" />
            <stop offset="1" stopColor="#34d399" />
          </linearGradient>
        </defs>
        {/* soundwave bars, left */}
        <rect x="7" y="19" width="3" height="10" rx="1.5" fill="#34d399" opacity="0.5" />
        <rect x="12" y="14" width="3" height="20" rx="1.5" fill="#34d399" opacity="0.75" />
        {/* soundwave bars, right */}
        <rect x="33" y="14" width="3" height="20" rx="1.5" fill="#34d399" opacity="0.75" />
        <rect x="38" y="19" width="3" height="10" rx="1.5" fill="#34d399" opacity="0.5" />
        {/* mic capsule */}
        <rect
          x="18"
          y="6"
          width="12"
          height="20"
          rx="6"
          stroke={`url(#${gid})`}
          strokeWidth="2.6"
        />
        {/* mic grille lines */}
        <path
          d="M21.5 12.5h5M21.5 16.5h5M21.5 20.5h5"
          stroke={`url(#${gid})`}
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity="0.75"
        />
        {/* mic stand */}
        <path
          d="M24 26v7"
          stroke={`url(#${gid})`}
          strokeWidth="2.6"
          strokeLinecap="round"
        />
        {/* mic base */}
        <path
          d="M18 37h12"
          stroke={`url(#${gid})`}
          strokeWidth="2.6"
          strokeLinecap="round"
        />
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
