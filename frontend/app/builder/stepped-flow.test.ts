/**
 * Builder stepped-flow tests (2026-10-18, Brandon: "don't try to force
 * every section on 1 page"). Source assertions, repo convention: the
 * builder is one step per screen — path choice first, then a short
 * sequence with Back / Continue. AI agents get the MCP door.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const builderSrc = readFileSync(join(here, "page.tsx"), "utf8");
const templatesSrc = readFileSync(
  join(here, "..", "..", "lib", "templates.ts"),
  "utf8"
);
const variantsSrc = readFileSync(
  join(here, "..", "..", "lib", "template-variants.ts"),
  "utf8"
);

describe("builder stepped flow", () => {
  it("starts on a path-choice screen, not a tab bar", () => {
    expect(builderSrc).toContain("How do you want to build?");
    expect(builderSrc).toContain("Build it myself");
    expect(builderSrc).toContain("Help me build it");
    expect(builderSrc).toContain("PathChoice");
    // The old three-tab bar is gone.
    expect(builderSrc).not.toContain("vb-tabs");
    expect(builderSrc).not.toContain("1 · Customize");
  });

  it("gives AI agents their own door to the MCP server", () => {
    expect(builderSrc).toContain('href="/mcp"');
    expect(builderSrc).toContain("I&apos;m an AI agent");
  });

  it("defines the self-serve path as template → customize → preview → wallet → publish", () => {
    expect(builderSrc).toContain(
      '["template", "customize", "preview", "wallet", "publish"]'
    );
    expect(builderSrc).toContain("SELF_STEP_LABELS");
  });

  it("defines the AI path as chat → review → publish", () => {
    expect(builderSrc).toContain('["chat", "review", "publish"]');
    expect(builderSrc).toContain("AI_STEP_LABELS");
  });

  it("routes the vs:open-builder-ai mic handoff to the AI path chat step", () => {
    expect(builderSrc).toContain('"vs:open-builder-ai"');
    expect(builderSrc).toContain('setPath("ai")');
    expect(builderSrc).toContain('setAiStep("chat")');
    expect(builderSrc).toContain('querySelector(".vb-voice-sec")');
  });

  it("reviews AI drafts on their own step before publish", () => {
    expect(builderSrc).toContain('setAiStep("review")');
    expect(builderSrc).toContain("Previewing AI changes");
    expect(builderSrc).toContain("Apply & continue");
  });

  it("gates the wallet step on a connected wallet", () => {
    expect(builderSrc).toContain("WalletStep");
    expect(builderSrc).toContain("nextDisabled={!account}");
  });

  it("offers a free instant variant re-roll in customize", () => {
    expect(builderSrc).toContain("rerollVariant");
    expect(builderSrc).toContain("Surprise me — new unique look");
    expect(builderSrc).toContain("createThemeVariant");
  });

  it("offers one-tap Remix with AI through the normal AI flow", () => {
    expect(builderSrc).toContain("remixWithAi");
    expect(builderSrc).toContain("Remix with AI");
    expect(builderSrc).toContain("initialPrompt={remixPrompt}");
    // The remix goes through send(), so the wallet gate and the
    // 25¢/edit economics are unchanged — no separate pricing path.
    expect(builderSrc).toContain("onInitialPromptConsumed");
  });

  it("persists the chosen path in autosave and sanitizes restores", () => {
    expect(builderSrc).toContain("path?: BuilderPath");
    expect(builderSrc).toContain("parsed.path === \"self\" || parsed.path === \"ai\"");
  });
});

describe("generative templates", () => {
  it("exposes the variant module API the builder uses", () => {
    for (const fn of [
      "export function createThemeVariant",
      "export function getTemplateDesign",
      "export function variantCssVars",
      "export function seedFromString",
      "export interface ThemeVariant",
      "export interface TemplateDesignSystem",
    ]) {
      expect(variantsSrc).toContain(fn);
    }
  });

  it("templates can carry a design system", () => {
    expect(templatesSrc).toContain("design?: TemplateDesignSystem");
  });

  it("picking a template mints a seeded variant into the theme", () => {
    expect(builderSrc).toContain("variant: createThemeVariant(");
    expect(builderSrc).toContain("getTemplateDesign(t)");
  });
});
