/**
 * Builder preview-mode + human-first claim-flow regression tests
 * (source assertions, repo convention).
 *
 * Brandon's calls:
 * - 2026-09-13: the blockpage builder was fully gated behind the wallet
 *   session — users couldn't even preview what they were making. The
 *   builder is now open to everyone; only publishing requires the wallet.
 * - 2026-09-27: human-first claim flow — no-wallet visitors describe +
 *   preview freely; the wallet connect is framed as "make it yours".
 *   The AI panel was rebuilt human-first: describe first, plain-language
 *   payment box below, no jargon ("x402"/"rail" gone from user copy).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const builderSrc = readFileSync(join(here, "page.tsx"), "utf8");
const sessionSrc = readFileSync(join(here, "..", "..", "lib", "session.tsx"), "utf8");

describe("builder preview mode", () => {
  it("the builder is not wrapped in a session gate", () => {
    expect(builderSrc).not.toContain("<RequireSession");
    expect(builderSrc).not.toMatch(/import\s*{[^}]*RequireSession[^}]*}\s*from\s*"@\/lib\/session"/);
  });

  it("shows an honest preview-mode banner to unsigned users", () => {
    expect(builderSrc).toMatch(/!isAuthenticated/);
    expect(builderSrc).toContain("vb-preview-banner");
    expect(builderSrc).toContain("Preview mode");
    // Claim framing: the wallet connect makes the page theirs.
    expect(builderSrc).toMatch(/this blockpage isn&apos;t yours yet/i);
    expect(builderSrc).toMatch(/connect your wallet to make it yours/i);
  });

  it("the banner offers the same wallet sign-in flow as the old gate", () => {
    expect(builderSrc).toContain("<SignInButton />");
  });

  it("lib/session exports SignInButton for reuse", () => {
    expect(sessionSrc).toMatch(/export function SignInButton/);
  });

  it("the publish flow still requests the wallet signature before publishing", () => {
    // Defense in depth: even if someone reaches Publish unsigned, the
    // signature prompt fires before any chain write.
    expect(builderSrc).toMatch(/requireSession\(\);[\s\S]{0,200}await signIn\(\)/);
  });
});

describe("human-first claim flow", () => {
  it("shows a 3-step tutorial to unsigned users, dismissible per browser", () => {
    expect(builderSrc).toContain("vb-tutorial");
    expect(builderSrc).toContain("Name it");
    expect(builderSrc).toContain("Preview it");
    expect(builderSrc).toContain("Make it yours");
    expect(builderSrc).toContain("vs-builder-tutorial-dismissed");
  });

  it("flashes an ownership confirmation when the visitor signs in", () => {
    expect(builderSrc).toContain("claimedFlash");
    expect(builderSrc).toMatch(/it.s yours now/i);
    expect(builderSrc).toMatch(/claimed to your wallet/i);
  });

  it("each wallet only ever sees its own page (no cross-user leakage)", () => {
    // The only on-chain load is the connected wallet's own registered page.
    expect(builderSrc).toMatch(/fetchRegisteredUsername\(account\)/);
    // Drafts stay in this browser; we keep no server copy of the canvas.
    expect(builderSrc).not.toMatch(/\/api\/builder\/draft/);
    expect(builderSrc).not.toMatch(/\/api\/drafts/);
  });
});

describe("AI panel human-first", () => {
  it("describe comes before payment in the panel", () => {
    const inputAt = builderSrc.indexOf("vb-chat-input-row");
    const payAt = builderSrc.indexOf('<div className="vb-x402-box"');
    expect(inputAt).toBeGreaterThan(-1);
    expect(payAt).toBeGreaterThan(-1);
    expect(inputAt).toBeLessThan(payAt);
  });

  it("the payment box speaks plain language", () => {
    expect(builderSrc).toContain("Each AI edit costs a small fee");
    expect(builderSrc).toContain("review the draft before anything changes");
    expect(builderSrc).toContain("generate draft");
    expect(builderSrc).toContain("cheapest");
    // Plain-language payment box: the current copy explains the fee without
    // rail/price-method jargon.
    expect(builderSrc).toContain("You pay from your wallet, then review the draft");
  });

  it("no jargon in user-facing copy", () => {
    expect(builderSrc).not.toContain("Pick a rail below");
    expect(builderSrc).not.toContain("Pay per edit (x402)");
    expect(builderSrc).not.toMatch(/aria-label="Payment rail"/);
  });

  it("the API-key path is a quiet advanced link, not a top-level choice", () => {
    expect(builderSrc).toContain("Advanced: use your own AI key instead");
    expect(builderSrc).not.toContain("vb-paymode");
    expect(builderSrc).not.toContain("Advanced: My AI key");
  });

  it("pay-per-edit AI needs the wallet; the typed text is kept", () => {
    expect(builderSrc).toMatch(
      /if \(payMode === "x402" && !isAuthenticated\) \{[\s\S]{0,300}return;\s*\}/,
    );
    expect(builderSrc).toMatch(/Connect your wallet to[\s\S]{0,24}unlock them/);
    expect(builderSrc).toMatch(/what makes this blockpage yours/);
  });

  it("BYOK still works wallet-free (their key, their spend)", () => {
    expect(builderSrc).toMatch(/payMode === "byok" \? \(/);
    expect(builderSrc).toContain("key stays in this browser");
  });
});
