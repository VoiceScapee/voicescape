/**
 * Draggable voice-mic position helpers — pure clamping logic.
 */
import { describe, expect, it } from "vitest";
import { clampMicPos, loadMicPos, MIC_POS_KEY } from "./voice-mic-position";

describe("clampMicPos", () => {
  it("keeps the interior position untouched", () => {
    expect(clampMicPos(200, 300, 390, 844)).toEqual({ x: 200, y: 300 });
  });

  it("clamps to the viewport edges with a margin", () => {
    expect(clampMicPos(-50, -20, 390, 844)).toEqual({ x: 8, y: 8 });
    expect(clampMicPos(9999, 9999, 390, 844)).toEqual({ x: 330, y: 784 });
  });

  it("never inverts on tiny viewports", () => {
    const p = clampMicPos(0, 0, 40, 40);
    expect(p.x).toBeGreaterThanOrEqual(8);
    expect(p.y).toBeGreaterThanOrEqual(8);
  });
});

describe("loadMicPos", () => {
  it("returns null outside the browser", () => {
    expect(loadMicPos()).toBeNull();
  });

  it("exports the stable storage key", () => {
    expect(MIC_POS_KEY).toBe("vs-mic-pos");
  });
});
