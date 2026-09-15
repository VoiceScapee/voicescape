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

  it("greets with the onboarding message on open", () => {
    expect(widgetSrc).toContain("Hey! I can look up blockpages");
  });

  it("labels itself beta and read-only", () => {
    expect(widgetSrc).toContain("Blockpage Buddy");
    expect(widgetSrc).toContain("beta · read-only");
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

  it("formats answers safely so users never see raw markdown", () => {
    // Backstop formatter: converts leftover markdown into React elements.
    expect(widgetSrc).toContain("renderBuddyText");
    expect(widgetSrc).toContain("<strong");
  });
});

describe("AgentChat formatter", () => {
  it("never uses innerHTML for chat text (no markup injection)", () => {
    // Everything renders as React elements — chat text can never inject markup.
    expect(widgetSrc).not.toContain("dangerouslySetInnerHTML");
  });

  it("handles headings, bullets, numbered steps, and tables without raw symbols", () => {
    expect(widgetSrc).toContain("/^(#{1,4})\\s+(.*)$/");
    expect(widgetSrc).toContain("/^[-*]\\s+(.*)$/");
    expect(widgetSrc).toContain("/^\\d+[.)]\\s+(.*)$/");
    // Table rows render as plain words, never raw pipes.
    expect(widgetSrc).toContain('trimmed.replace(/\\|/g, " ")');
  });
});
