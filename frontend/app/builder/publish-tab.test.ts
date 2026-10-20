/**
 * Builder publish-step handoff tests (source assertions, repo convention):
 * the chat widget's "Publish page" button hands a Buddy draft to the
 * builder with a one-time intent flag; the builder must open its existing
 * Publish step (no duplicated publish logic). Stepped flow (2026-10-18):
 * the old tab switch is now a path + step switch.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const builderSrc = readFileSync(join(here, "page.tsx"), "utf8");
const onboardingSrc = readFileSync(
  join(here, "..", "..", "components", "Onboarding.tsx"),
  "utf8"
);

describe("builder publish handoff", () => {
  it("consumes the one-time Buddy publish intent and opens the Publish step", () => {
    expect(builderSrc).toContain("consumeBuddyPublishIntent");
    // Stepped flow: the handoff lands on the AI path's publish step
    // (a Buddy draft is AI-assisted work).
    expect(builderSrc).toContain('setAiStep("publish")');
    expect(builderSrc).toContain('setPath("ai")');
  });

  it("supports a /builder?tab=publish deep link", () => {
    expect(builderSrc).toContain('get("tab") === "publish"');
  });

  it("Onboarding defines the publish-intent key as a one-shot session flag", () => {
    expect(onboardingSrc).toContain(
      'BUDDY_PUBLISH_INTENT_KEY = "vs_buddy_publish_intent"'
    );
    expect(onboardingSrc).toContain("export function consumeBuddyPublishIntent");
    // One-shot: read clears it, so a fresh tab never inherits intent.
    expect(onboardingSrc).toContain(
      "sessionStorage.removeItem(BUDDY_PUBLISH_INTENT_KEY)"
    );
  });

  it("does not duplicate the publish flow — the existing PublishPanel stays the owner", () => {
    // The handoff only switches steps; PublishPanel keeps doing the
    // signing/pinning/registering. No second publish implementation.
    expect(builderSrc).toContain("PublishPanel");
    expect(builderSrc).not.toContain("publishBuddyDraft");
  });
});
