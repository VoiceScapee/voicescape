/**
 * Builder publish-tab handoff tests (source assertions, repo convention):
 * the chat widget's "Publish page" button hands a Buddy draft to the
 * builder with a one-time intent flag; the builder must open its existing
 * Publish tab (no duplicated publish logic).
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
  it("consumes the one-time Buddy publish intent and opens the Publish tab", () => {
    expect(builderSrc).toContain("consumeBuddyPublishIntent");
    expect(builderSrc).toContain('setTab("publish")');
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
    // The handoff only switches tabs; PublishPanel keeps doing the
    // signing/pinning/registering. No second publish implementation.
    expect(builderSrc).toContain("PublishPanel");
    expect(builderSrc).not.toContain("publishBuddyDraft");
  });
});
