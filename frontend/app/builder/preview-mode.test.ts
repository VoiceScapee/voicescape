/**
 * Builder preview-mode regression tests (source assertions, repo convention).
 *
 * Brandon's call 2026-09-13: the blockpage builder was fully gated behind
 * the wallet session — users couldn't even preview what they were making.
 * The builder is now open to everyone; only publishing requires the wallet.
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
    expect(builderSrc).toContain("Preview mode.");
    // Publishing — not designing — is what needs the wallet.
    expect(builderSrc).toMatch(/connect your wallet when you're ready to publish/i);
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
