interface LogoProps {
  size?: number;
  withWordmark?: boolean;
}

/**
 * Voicescape logo: the official approved lockup — a microphone with
 * radiating sound waves plus the gradient "Voicescape" wordmark
 * (Brandon's direction: "something with a microphone and sound wave").
 *
 * The asset is a transparent WebP, so it blends into any dark-theme
 * surface with no visible box around it.
 *
 * `withWordmark` is kept for API compatibility — the wordmark is baked into
 * the lockup, so the full lockup always renders (no call site passes false).
 */
export default function Logo({ size = 32, withWordmark = true }: LogoProps) {
  void withWordmark;
  return (
    <img
      src="/voicescape-logo.webp"
      alt="Voicescape logo"
      width={size * 3} // lockup is 2736x912 (3:1)
      height={size}
      draggable={false}
      style={{
        display: "block",
        height: size,
        width: "auto",
        userSelect: "none",
      }}
    />
  );
}
