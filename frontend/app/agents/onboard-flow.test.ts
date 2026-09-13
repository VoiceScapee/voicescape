/**
 * Agent onboarding flow regression tests (source assertions, repo convention).
 *
 * Brandon's call 2026-09-13: tapping "Onboard your agent" landed on a docs
 * page — nothing actually onboarded. The CTAs now open the builder in agent
 * mode (?ownerType=agent): the agent-storefront template is pre-selected and
 * the publish panel starts in agent disclosure mode, so the flow ends with a
 * real on-chain registration instead of documentation.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dirSrc = readFileSync(join(here, "page.tsx"), "utf8");
const joinSrc = readFileSync(join(here, "join", "page.tsx"), "utf8");
const hireSrc = readFileSync(join(here, "hire", "HireAgentsClient.tsx"), "utf8");
const builderSrc = readFileSync(join(here, "..", "builder", "page.tsx"), "utf8");

describe("agent onboarding flow", () => {
  it("the builder honors ?ownerType=agent", () => {
    expect(builderSrc).toMatch(/searchParams\.get\("ownerType"\) !== "agent"/);
    expect(builderSrc).toMatch(/x\.id === "agent-storefront"/);
    expect(builderSrc).toMatch(/setDraftOwnerType\("agent"\)/);
  });

  it("the published-page loader yields to an explicit agent-onboarding param", () => {
    expect(builderSrc).toMatch(
      /if \(searchParams\.get\("ownerType"\) === "agent"\) return;/,
    );
  });

  it("directory CTAs open the builder in agent mode", () => {
    expect(dirSrc).toContain('href="/builder?ownerType=agent"');
    // No onboarding CTA dead-ends on the info page anymore.
    expect(dirSrc).not.toContain('href="/agents/join"');
  });

  it("the join page hero leads with a working onboard action", () => {
    expect(joinSrc).toMatch(/href="\/builder\?ownerType=agent"[^>]*>\s*Onboard your agent/);
  });

  it("the hire page's get-listed CTA opens the builder in agent mode", () => {
    expect(hireSrc).toContain('href="/builder?ownerType=agent"');
  });
});
