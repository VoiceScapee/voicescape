/**
 * Content filter tests — pure function, no network.
 */
import { describe, expect, it } from "vitest";
import { checkContent, checkUrl, MAX_URLS_PER_POST } from "./content-filter";

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

  it("blocks phone numbers (immutable HCS — use DMs)", () => {
    const r = checkContent("call me at 555-123-4567", "post body");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("phone numbers");
    // International format too.
    expect(checkContent("my number is +1 (555) 123-4567").allowed).toBe(false);
  });

  it("blocks email addresses", () => {
    const r = checkContent("email me at bob@example.com for details");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("email");
  });

  it("blocks profanity", () => {
    for (const t of ["this is fucking great", "you are a bitch", "what the shit"]) {
      const r = checkContent(t);
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain("profanity");
    }
    // Word boundaries: "hello" and "Scunthorpe" must pass.
    expect(checkContent("hello everyone").allowed).toBe(true);
    expect(checkContent("Scunthorpe is a town in England").allowed).toBe(true);
  });

  it("blocks hate-speech slurs", () => {
    const r = checkContent("those faggots ruined it", "chat message");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("hate speech");
  });

  it("blocks dangerous link schemes", () => {
    const r = checkContent("click javascript:alert(1) here");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("unsafe link");
  });

  it("blocks known phishing/scam domains", () => {
    const r = checkContent("claim your free mint at https://hashpack-claim.example.com now");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("phishing");
  });

  it("blocks link spam (too many URLs)", () => {
    const spam = [
      "https://a.com/1",
      "https://b.com/2",
      "https://c.com/3",
      "https://d.com/4",
    ].join(" ");
    const r = checkContent(`check these out ${spam}`, "post body");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("too many links");
    expect(r.reason).toContain(String(MAX_URLS_PER_POST));
    // At the limit is fine.
    expect(
      checkContent("see https://a.com/1 https://b.com/2 https://c.com/3 thanks").allowed,
    ).toBe(true);
  });

  it("blocks spam heuristics", () => {
    expect(checkContent("soooooo goooood!!!!!!!!").allowed).toBe(false); // repeated chars
    expect(checkContent("buy buy buy buy buy now").allowed).toBe(false); // repeated words
    expect(
      checkContent("THIS IS AN ALL CAPS SHOUTING MESSAGE TO EVERYONE").allowed,
    ).toBe(false);
    // Normal mixed case passes.
    expect(checkContent("This is a normal sentence with some CAPS for emphasis.").allowed).toBe(true);
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

describe("checkUrl", () => {
  it("allows ordinary https URLs", () => {
    expect(checkUrl("https://example.com/page", "link").allowed).toBe(true);
    expect(checkUrl("http://example.com", "link").allowed).toBe(true);
    expect(checkUrl("example.com/some/path", "link").allowed).toBe(true); // scheme added
  });

  it("blocks dangerous schemes", () => {
    for (const u of ["javascript:alert(1)", "data:text/html,<h1>x</h1>", "file:///etc/passwd"]) {
      const r = checkUrl(u, "link");
      expect(r.allowed).toBe(false);
    }
  });

  it("blocks phishing/scam domains and subdomains", () => {
    expect(checkUrl("https://hashpack-claim.evil.com", "link").allowed).toBe(false);
    expect(checkUrl("https://wallet-verify.phish.io/login", "link").allowed).toBe(false);
  });

  it("blocks URLs with embedded credentials", () => {
    expect(checkUrl("https://user:pass@example.com", "link").allowed).toBe(false);
  });

  it("blocks overlong URLs", () => {
    expect(checkUrl("https://example.com/" + "a".repeat(600), "link").allowed).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(checkUrl("not a url at all !!!", "link").allowed).toBe(false);
    expect(checkUrl("", "link").allowed).toBe(false);
  });
});
