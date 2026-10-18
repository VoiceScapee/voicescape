/**
 * Haptics for mobile web — the tactile half of the press-state system.
 * navigator.vibrate() is the zero-cost equivalent of native haptics;
 * every call is guarded (desktop browsers, permissions, SSR).
 */
export function tap(pattern: number | number[] = 10) {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(pattern);
    }
  } catch {
    // Haptics are decorative — never let them throw.
  }
}

/** Slightly stronger pulse for the money moment (tip confirmed). */
export function confirmPulse() {
  tap([12, 40, 18]);
}
