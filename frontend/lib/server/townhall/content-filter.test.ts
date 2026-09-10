/**
 * Content filter tests — pure function, no network.
 */
import { describe, expect, it } from "vitest";
import { checkContent } from "./content-filter";

describe("checkContent", () => {
  it("allows ordinary text", () => {
    expect(checkContent("Hello everyone, welcome to the lobby!").allowed).toBe(true);
    expect(checkContent("").allowed).toBe(true);
    expect(checkContent("Selling my old keyboard, $50, DM me").allowed).toBe(true);
  });

  it("is case-insensitive", () => {
    const r = checkContent("I WILL KILL YOU TOMORROW", "post body");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("threats of violence");
  });

  it("blocks explicit violent threats", () => {
    for (const t of [
      "i will kill you",
      "I'm gonna murder him",
      "im going to shoot everyone",
      "there is a bomb threat at the venue",
      "we will shoot up the place",
      "kill yourself",
    ]) {
      const r = checkContent(t);
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain("threats of violence");
    }
  });

  it("does not block benign uses of flagged words", () => {
    // "kill" alone in a gaming context is not a first-person threat.
    expect(checkContent("that boss fight will kill me lol").allowed).toBe(true);
  });

  it("blocks CSAM phrases", () => {
    const r = checkContent("anyone got child porn links?", "chat message");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("sexual content involving minors");
    expect(r.reason).toContain("chat message");
  });

  it("blocks terrorist organization names", () => {
    const r = checkContent("join isis today");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("terrorist content");
  });

  it("blocks SSN-shaped numbers", () => {
    const r = checkContent("my ssn is 123-45-6789 call me");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("SSN");
  });

  it("blocks valid payment card numbers (Luhn)", () => {
    // 4242 4242 4242 4242 is Luhn-valid (test card).
    const r = checkContent("pay me with card 4242 4242 4242 4242 please");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("payment card");
  });

  it("allows digit runs that fail Luhn", () => {
    expect(checkContent("order number 1234567890123 confirmed").allowed).toBe(true);
  });

  it("allows phone-number-shaped text", () => {
    expect(checkContent("call me at 555-123-4567").allowed).toBe(true);
  });

  it("never echoes matched content in the reason", () => {
    const secret = "999-99-9999";
    const r = checkContent(`ssn ${secret} here`);
    expect(r.allowed).toBe(false);
    expect(r.reason).not.toContain(secret);
  });

  it("runs fast on max-length input (<5ms)", () => {
    const big = "lorem ipsum dolor sit amet ".repeat(200).slice(0, 5000);
    const start = performance.now();
    for (let i = 0; i < 50; i++) checkContent(big);
    const perCall = (performance.now() - start) / 50;
    expect(perCall).toBeLessThan(5);
  });
});
