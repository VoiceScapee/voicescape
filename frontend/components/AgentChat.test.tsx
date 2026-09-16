/**
 * AgentChat widget tests (source assertions, repo convention): the widget
 * must be a client component, hit the chat API, degrade gracefully on
 * 503/429, and be mounted in the root layout.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const widgetSrc = readFileSync(join(here, "AgentChat.tsx"), "utf8");
const layoutSrc = readFileSync(join(here, "..", "app", "layout.tsx"), "utf8");

describe("AgentChat", () => {
  it("is a client component with a floating toggle button", () => {
    expect(widgetSrc).toContain('"use client"');
    expect(widgetSrc).toContain("position: \"fixed\"");
    expect(widgetSrc).toContain("/api/agent/chat");
  });

  it("greets with the Buddy onboarding welcome (no treasury pitch)", () => {
    expect(widgetSrc).toContain("Hey, welcome to Voicescape!");
    expect(widgetSrc).toContain("I'm Buddy.");
    expect(widgetSrc).toContain("Want the quick tour, or ready to build your page?");
    expect(widgetSrc).not.toContain("treasury");
  });

  it("shows the hammer bubble and the tagline header", () => {
    expect(widgetSrc).toContain("Blockpage Buddy");
    expect(widgetSrc).toContain("Ask me anything — I check the chain");
    expect(widgetSrc).toContain("Ask Buddy…");
    expect(widgetSrc).toContain("🔨");
    expect(widgetSrc).not.toContain("beta · read-only");
  });

  it("degrades gracefully when the backend is unavailable or rate-limited", () => {
    expect(widgetSrc).toContain("Chat is unavailable right now — try again later.");
    expect(widgetSrc).toContain("Slow down a little — try again in a bit.");
    expect(widgetSrc).toContain("503");
    expect(widgetSrc).toContain("429");
  });

  it("sends at most 6 history items with each message", () => {
    expect(widgetSrc).toContain(".slice(-6)");
  });

  it("is mounted in the root layout", () => {
    expect(layoutSrc).toContain('import AgentChat from "@/components/AgentChat"');
    expect(layoutSrc).toContain("<AgentChat />");
  });

  it("shows the one-time post-publish celebration and consumes the flag", () => {
    expect(widgetSrc).toContain("🎉 Your blockpage is live!");
    expect(widgetSrc).toContain("BUDDY_CELEBRATE_KEY");
    expect(widgetSrc).toContain('localStorage.removeItem(BUDDY_CELEBRATE_KEY)');
  });

  it("markPublished arms the Buddy celebration flag", () => {
    const triggerSrc = readFileSync(join(here, "OnboardingTrigger.tsx"), "utf8");
    expect(triggerSrc).toContain('BUDDY_CELEBRATE_KEY = "vs_buddy_celebrate"');
    expect(triggerSrc).toContain("localStorage.setItem(BUDDY_CELEBRATE_KEY");
  });

  it("renders assistant replies as styled markdown, not raw text", () => {
    expect(widgetSrc).toContain("react-markdown");
    expect(widgetSrc).toContain("remark-gfm");
    expect(widgetSrc).toContain("BuddyMarkdown");
    // User messages stay plain; assistant messages go through markdown.
    expect(widgetSrc).toContain("m.role === \"assistant\" ? (");
  });

  it("offers one-tap builder handoff for Buddy-built page drafts", () => {
    expect(widgetSrc).toContain("extractPageDraft");
    expect(widgetSrc).toContain("stripPageDraft");
    expect(widgetSrc).toContain("saveBuddyDraft");
    expect(widgetSrc).toContain("Open in Builder");
    expect(widgetSrc).toContain('"/builder"');
  });

  it("previews the draft inline in the chat before the builder button", () => {
    expect(widgetSrc).toContain('import BuddyDraftPreview from "./BuddyDraftPreview"');
    expect(widgetSrc).toContain("<BuddyDraftPreview page={draft}");
  });

  it("Onboarding stores Buddy drafts under a dedicated key", () => {
    const onboardingSrc = readFileSync(join(here, "Onboarding.tsx"), "utf8");
    expect(onboardingSrc).toContain('BUDDY_DRAFT_KEY = "vs_buddy_draft"');
    expect(onboardingSrc).toContain("saveBuddyDraft");
    expect(onboardingSrc).toContain("consumeBuddyDraft");
    expect(onboardingSrc).toContain("isValidPage(data)");
  });

  it("echoes the server's signed build-state token each turn (never displays it)", () => {
    expect(widgetSrc).toContain("buildStateRef");
    expect(widgetSrc).toContain("build_state: buildStateRef.current");
    expect(widgetSrc).toContain('typeof data.build_state === "string"');
    expect(widgetSrc).toContain("buildStateRef.current = data.build_state");
  });
});
