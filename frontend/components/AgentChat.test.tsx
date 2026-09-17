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

  it("shows the in-chat Pay 5 HBAR control on the build paywall", () => {
    expect(widgetSrc).toContain("BuddyPayButton");
    expect(widgetSrc).toContain("build.paywall");
    expect(widgetSrc).toContain('"anon"');
    expect(widgetSrc).toContain('"unpaid"');
    expect(widgetSrc).toContain("/api/agent/chat/build-credit");
    expect(widgetSrc).toContain("Payment detected");
    expect(widgetSrc).toContain("No build credit detected yet");
  });

  it("the pay button reuses the existing forge tip path (no new money code)", () => {
    const paySrc = readFileSync(join(here, "BuddyPayButton.tsx"), "utf8");
    expect(paySrc).toContain("Pay 5 HBAR");
    expect(paySrc).toContain("BUILD_PAYMENT_WEI = 5_000_000_000_000_000_000n");
    expect(paySrc).toContain('tipPage(BUDDY_PAGE_USERNAME, BUILD_PAYMENT_WEI, sender)');
    expect(paySrc).toContain('BUDDY_PAGE_USERNAME = "forge"');
    expect(paySrc).toContain("resolvePage(");
    expect(paySrc).toContain("friendlyWalletError");
    // No custom payment rail: no raw contract addresses, no ethers-as-signer.
    expect(paySrc).not.toMatch(/0x[a-fA-F0-9]{40}/);
    expect(paySrc).not.toContain("ethers");
  });

  it("offers Publish page and Tweak next to Open in Builder", () => {
    expect(widgetSrc).toContain("Publish page");
    expect(widgetSrc).toContain("publishDraft(draft)");
    expect(widgetSrc).toContain("BUDDY_PUBLISH_INTENT_KEY");
    expect(widgetSrc).toContain("✏️ Tweak");
    expect(widgetSrc).toContain("refine_draft");
    expect(widgetSrc).toContain("Tell Buddy what to change");
  });

  it("renders the free visual-mock preview in-chat via BuddyDraftPreview", () => {
    expect(widgetSrc).toContain("build.preview");
    expect(widgetSrc).toContain("isValidPage(b.preview)");
    // Client-side render-safety: the mock is normalized before it reaches
    // the renderer (belt and suspenders — the server already normalized),
    // and the preview sits inside an error boundary so a render throw can
    // never unmount the app (live crash 2026-09-16).
    expect(widgetSrc).toContain("normalizeBlockForRender");
    expect(widgetSrc).toContain("setPreviewDraft(safe)");
    expect(widgetSrc).toContain("PreviewErrorBoundary");
    expect(widgetSrc).toContain("setPreviewsLeft(");
    expect(widgetSrc).toContain("<BuddyDraftPreview page={previewDraft} />");
  });

  it("the free-mock panel labels remaining tweaks and placeholder-art status", () => {
    expect(widgetSrc).toContain("🎨 Preview");
    expect(widgetSrc).toContain("free previews used");
    // Rendered as "· 1 free tweak left" / "· 2 free tweaks left" via a
    // template literal — assert the tokens.
    expect(widgetSrc).toContain("free ${");
    expect(widgetSrc).toContain('"tweak"');
    expect(widgetSrc).toContain('"tweaks"');
    expect(widgetSrc).toContain("This mock uses placeholder art.");
    expect(widgetSrc).toContain("Pay 5 HBAR below and");
  });

  it("the free-mock panel has no Open in Builder / Publish page buttons", () => {
    // The preview panel renders BuddyDraftPreview and the tweak control;
    // "Open in Builder" and "Publish page" only appear on the paid-draft
    // card. (Slice from the panel's JSX, past its own comment.)
    const panelStart = widgetSrc.indexOf("{previewDraft && (");
    const previewBlock = widgetSrc.slice(
      panelStart,
      widgetSrc.indexOf("{/* Input */}")
    );
    expect(panelStart).toBeGreaterThan(-1);
    expect(previewBlock).toContain("<BuddyDraftPreview page={previewDraft} />");
    expect(previewBlock).toContain("Tweak this preview");
    expect(previewBlock).not.toContain("Open in Builder");
    expect(previewBlock).not.toContain("Publish page");
  });

  it("'Tweak this preview' arms tweak mode and the message sends preview_draft", () => {
    expect(widgetSrc).toContain("✏️ Tweak this preview");
    expect(widgetSrc).toContain("setTweakingPreview(true)");
    expect(widgetSrc).toContain("preview_draft:");
    expect(widgetSrc).toContain("tweakingPreview && previewDraft");
    expect(widgetSrc).toContain("JSON.stringify(previewDraft)");
  });

  it("a paid draft supersedes the free mock (clears it and the tweak state)", () => {
    expect(widgetSrc).toContain("the free mock (superseded)");
    expect(widgetSrc).toContain("const newDraft = extractPageDraft(reply)");
    // The paid-draft branch resets the preview state.
    const paidBranch = widgetSrc.slice(widgetSrc.indexOf("const newDraft = extractPageDraft(reply)"));
    expect(paidBranch).toContain("setPreviewDraft(null)");
  });
});
