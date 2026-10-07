/**
 * AgentTokensCard tests (source assertions, repo convention): the human's
 * "agent access" card must be a client component, talk to the token API with
 * the wallet session header, show the raw token exactly once without ever
 * persisting it, and keep the copy honest (not a key, can't sign anything).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cardSrc = readFileSync(join(here, "AgentTokensCard.tsx"), "utf8");
// What the human actually reads: entities decoded, whitespace collapsed.
const cardText = cardSrc.replace(/&apos;/g, "'").replace(/\s+/g, " ");
const dashSrc = readFileSync(join(here, "BuddyDashboard.tsx"), "utf8");
const serverSrc = readFileSync(
  join(here, "..", "lib", "server", "capability-tokens.ts"),
  "utf8"
);

describe("AgentTokensCard", () => {
  it("is a client component that talks to the token API with the session header", () => {
    expect(cardSrc).toContain('"use client"');
    expect(cardSrc).toContain("/api/agents/tokens");
    expect(cardSrc).toContain("SESSION_HEADER");
    expect(cardSrc).toContain("restoreSession");
  });

  it("covers list, issue, and revoke", () => {
    expect(cardSrc).toContain('method: "POST"');
    expect(cardSrc).toContain('method: "DELETE"');
    expect(cardSrc).toContain("Revoke");
    expect(cardSrc).toContain("Issue token");
  });

  it("shows the raw token exactly once and never persists it client-side", () => {
    expect(cardSrc).toContain("only time you");
    expect(cardSrc).toContain("Copy token");
    // React state only: no localStorage writes, no cookies, no logging.
    expect(cardSrc).not.toContain("localStorage.setItem");
    expect(cardSrc).not.toContain("document.cookie");
    expect(cardSrc).not.toContain("console.log");
  });

  it("keeps the copy honest: not a key, can't sign, human tap still required", () => {
    expect(cardText).toContain("without ever touching a private key");
    expect(cardText).toContain("can't sign anything");
    expect(cardText).toContain("every on-chain change still needs your wallet tap");
  });

  it("scopes match the server's CAPABILITY_SCOPES exactly", () => {
    for (const scope of ["page:update:propose", "page:read", "media:pin"]) {
      expect(serverSrc).toContain(`"${scope}"`);
      expect(cardSrc).toContain(`"${scope}"`);
    }
  });

  it("revocation is a two-tap confirm and reads as instant", () => {
    expect(cardSrc).toContain("Yes, revoke it");
    expect(cardSrc).toContain("immediately");
  });

  it("explains the empty state in plain words, no jargon", () => {
    expect(cardSrc).toContain("No tokens yet");
    expect(cardSrc).toContain("one-tap approval");
  });

  it("degrades for signed-out visitors without breaking the chat", () => {
    expect(cardSrc).toContain("signed-out");
    expect(cardSrc).toContain("sign in with your wallet");
  });

  it("is mounted in the dashboard's agent-access area", () => {
    expect(dashSrc).toContain("AgentTokensCard");
    expect(dashSrc).toContain("Agent tokens");
  });
});
