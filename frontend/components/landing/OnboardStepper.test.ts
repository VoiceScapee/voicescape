/**
 * OnboardStepper regression tests (source assertions, repo convention).
 *
 * Brand pass PORT-O: the /new-to-web3 page's "Crypto, explained like a
 * human" stepper must stay wired to the onboard.* i18n keys, keep the
 * approved illustrative journey states (step 1 done, step 2 active,
 * steps 3–4 upcoming), and keep the Back / Keep-going buttons pointing
 * at history-back and /builder.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "OnboardStepper.tsx"), "utf8");
const pageSrc = readFileSync(join(here, "..", "..", "app", "new-to-web3", "page.tsx"), "utf8");

describe("OnboardStepper (brand pass PORT-O)", () => {
  it("uses the onboard.* i18n keys — no hard-coded English copy", () => {
    for (const k of [
      "onboard.eyebrow",
      "onboard.title",
      "onboard.lede",
      "onboard.s1t",
      "onboard.s1b",
      "onboard.s2t",
      "onboard.s2b",
      "onboard.s3t",
      "onboard.s3b",
      "onboard.s4t",
      "onboard.s4b",
      "onboard.back",
      "onboard.keepGoing",
    ]) {
      expect(src).toContain(k);
    }
  });

  it("keeps the approved illustrative journey states", () => {
    expect(src).toMatch(/state:\s*"done"/);
    expect(src).toMatch(/state:\s*"active"/);
    expect(src).toMatch(/state:\s*"upcoming"/);
    // Done step renders a check; active/upcoming render their number.
    expect(src).toContain('"✓"');
  });

  it("Back goes to history, Keep going goes to /builder", () => {
    expect(src).toContain("router.back()");
    expect(src).toContain('router.push("/builder")');
  });

  it("the /new-to-web3 page renders the stepper with the live sections intact", () => {
    expect(pageSrc).toContain("<OnboardStepper />");
    expect(pageSrc).toContain("<NewToWeb3 />");
    expect(pageSrc).toContain("<FeeStrip />");
  });
});
