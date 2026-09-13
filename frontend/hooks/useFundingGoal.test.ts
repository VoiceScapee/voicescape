import { describe, expect, it } from "vitest";
import { isFundingGoalReached } from "./useFundingGoal";

describe("isFundingGoalReached", () => {
  it("is open when raised is below target", () => {
    expect(isFundingGoalReached({ targetHbar: 100 }, 99.99)).toBe(false);
  });

  it("is reached when raised exactly meets target", () => {
    expect(isFundingGoalReached({ targetHbar: 100 }, 100)).toBe(true);
  });

  it("is reached when raised exceeds target", () => {
    expect(isFundingGoalReached({ targetHbar: 100 }, 150.5)).toBe(true);
  });

  it("is open when there is no goal", () => {
    expect(isFundingGoalReached(null, 1000)).toBe(false);
  });

  it("is open when raised has not loaded yet", () => {
    expect(isFundingGoalReached({ targetHbar: 100 }, null)).toBe(false);
  });

  it("is open when the target is invalid", () => {
    expect(isFundingGoalReached({ targetHbar: 0 }, 50)).toBe(false);
    expect(isFundingGoalReached({ targetHbar: -10 }, 50)).toBe(false);
    expect(isFundingGoalReached({ targetHbar: NaN }, 50)).toBe(false);
  });
});
