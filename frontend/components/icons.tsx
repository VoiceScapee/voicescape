/* Stroke icon set for Voicescape UI chrome. Inline SVG only — no emoji. */

interface IconProps {
  size?: number;
  className?: string;
}

function Base({
  size = 18,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconWallet({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="M20 7H5a2 2 0 0 1 0-4h14v4" />
      <path d="M20 7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" />
      <circle cx="17.5" cy="14" r="1.4" />
    </Base>
  );
}

export function IconTip({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="M12 2v13" />
      <path d="M7 7h7a3.5 3.5 0 0 1 0 7H9" />
      <path d="M5 21h14" />
    </Base>
  );
}

export function IconSpark({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="m7.8 7.8 2.1 2.1M14.1 14.1l2.1 2.1M16.2 7.8l-2.1 2.1M9.9 14.1l-2.1 2.1" />
      <circle cx="12" cy="12" r="1.6" />
    </Base>
  );
}

export function IconLink({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="M10 14a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.5 1.5" />
      <path d="M14 10a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.5-1.5" />
    </Base>
  );
}

export function IconMusic({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <circle cx="6" cy="18" r="2.6" />
      <circle cx="18" cy="16" r="2.6" />
      <path d="M8.6 18V5l9.4-2.6V16" />
    </Base>
  );
}

export function IconBook({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 0 4 4.5v15Z" />
      <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
      <path d="M9 7h7" />
    </Base>
  );
}

export function IconGrid({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </Base>
  );
}

export function IconClose({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Base>
  );
}

export function IconCheck({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Base>
  );
}

export function IconArrowRight({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="M4 12h15M13 6l6 6-6 6" />
    </Base>
  );
}

export function IconChevronDown({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="M6 9l6 6 6-6" />
    </Base>
  );
}

export function IconPlus({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="M12 5v14M5 12h14" />
    </Base>
  );
}

export function IconTrash({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13" />
      <path d="M10 11v6M14 11v6" />
    </Base>
  );
}

export function IconUsers({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3.4 3.4 0 0 1 0 5.9M17.5 14.9a5.5 5.5 0 0 1 3 5.1" />
    </Base>
  );
}

export function IconBolt({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z" />
    </Base>
  );
}

export function IconGlobe({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.4 3.8 5.3 3.8 8.5s-1.3 6.1-3.8 8.5c-2.5-2.4-3.8-5.3-3.8-8.5s1.3-6.1 3.8-8.5Z" />
    </Base>
  );
}

export function IconExternal({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="M14 4h6v6M20 4 11 13" />
      <path d="M19 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5.5" />
    </Base>
  );
}

export function IconPlay({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="M7 4.5v15l12-7.5-12-7.5Z" />
    </Base>
  );
}

export function IconPause({ size, className }: IconProps) {
  return (
    <Base size={size} className={className}>
      <path d="M8.5 5v14M15.5 5v14" />
    </Base>
  );
}
