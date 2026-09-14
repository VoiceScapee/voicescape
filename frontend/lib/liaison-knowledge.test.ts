/**
 * Tests for the liaison deterministic knowledge base: known questions
 * match, unknown questions return null (honest fallback), money trouble
 * escalates, and the price placeholder is filled.
 */
import { describe, expect, it } from "vitest";
import {
  LIAISON_MONEY_ESCALATION,
  LIAISON_UNKNOWN_FALLBACK,
  findLiaisonAnswer,
} from "./liaison-knowledge";

describe("findLiaisonAnswer", () => {
  it("answers who-danny-is questions", () => {
    const a = findLiaisonAnswer("who are you?");
    expect(a).not.toBeNull();
    expect(a!.entryId).toBe("what-is-danny");
    expect(a!.answer).toContain("never touch your page");
  });

  it("answers how-help-works with the live price filled in", () => {
    const a = findLiaisonAnswer("how much does it cost?", 7);
    expect(a).not.toBeNull();
    expect(a!.entryId).toBe("how-help-works");
    expect(a!.answer).toContain("7 HBAR");
    expect(a!.answer).not.toContain("{price}");
  });

  it("answers tips questions", () => {
    const a = findLiaisonAnswer("how do tips work");
    expect(a).not.toBeNull();
    expect(a!.entryId).toBe("tips");
  });

  it("returns null for uncovered questions (caller falls back honestly)", () => {
    expect(findLiaisonAnswer("what is the weather on mars")).toBeNull();
    expect(findLiaisonAnswer("")).toBeNull();
    expect(findLiaisonAnswer("ok")).toBeNull();
  });

  it("escalates money-movement trouble instead of guessing", () => {
    const a = findLiaisonAnswer("my tip didn't arrive, where is my money");
    expect(a).not.toBeNull();
    expect(a!.entryId).toBe("money-escalation");
    expect(a!.answer).toBe(LIAISON_MONEY_ESCALATION);
  });

  it("exports a non-empty honest fallback", () => {
    expect(LIAISON_UNKNOWN_FALLBACK.length).toBeGreaterThan(20);
  });
});
