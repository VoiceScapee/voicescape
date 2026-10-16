/**
 * Draggable voice-mic position — pure helpers (no DOM at import time).
 *
 * The mic floats bottom-left by default; the visitor can drag it anywhere
 * and the spot persists in localStorage across pages and visits.
 */

export interface MicPos {
  x: number;
  y: number;
}

export const MIC_POS_KEY = "vs-mic-pos";

/** Button footprint (52px) plus a small margin from the viewport edge. */
const EDGE = 8;
const FOOTPRINT = 60;

/** Keep the mic button fully on-screen. Pure — unit-tested. */
export function clampMicPos(x: number, y: number, vw: number, vh: number): MicPos {
  return {
    x: Math.min(Math.max(x, EDGE), Math.max(EDGE, vw - FOOTPRINT)),
    y: Math.min(Math.max(y, EDGE), Math.max(EDGE, vh - FOOTPRINT)),
  };
}

/** Read the saved spot. Null on the server or when nothing was saved. */
export function loadMicPos(): MicPos | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MIC_POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<MicPos>;
    if (typeof p.x === "number" && typeof p.y === "number") return { x: p.x, y: p.y };
  } catch {
    // Corrupt value or blocked storage — fall back to the default spot.
  }
  return null;
}

/** Persist the spot. Never throws (private-mode storage, etc.). */
export function saveMicPos(pos: MicPos): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MIC_POS_KEY, JSON.stringify(pos));
  } catch {
    // Storage unavailable — the mic still works, it just won't persist.
  }
}
