/**
 * MCP Apps widget tests — blockpage preview card.
 *
 * Verifies the widget HTML is self-contained, sandboxed-safe (no key
 * handling, no signing), and carries the MCP Apps MIME profile.
 */
import { describe, expect, it } from "vitest";
import { BLOCKPAGE_PREVIEW_URI, WIDGET_CSP, blockpagePreviewHtml } from "./mcp-widgets";

describe("blockpage preview widget", () => {
  it("uses the ui:// scheme", () => {
    expect(BLOCKPAGE_PREVIEW_URI.startsWith("ui://")).toBe(true);
  });

  it("returns self-contained HTML", () => {
    const html = blockpagePreviewHtml();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
    // No external scripts — sandboxed widgets must be self-contained.
    expect(html).not.toMatch(/<script\s+src=/);
  });

  it("never touches keys or signing", () => {
    const html = blockpagePreviewHtml().toLowerCase();
    expect(html).not.toContain("privatekey");
    expect(html).not.toContain("private_key");
    expect(html).not.toContain("seed phrase");
    expect(html).not.toContain("mnemonic");
  });

  it("hands money actions off via ui/open-link (wallet stays the authority)", () => {
    const html = blockpagePreviewHtml();
    // SEP-1865 uses kebab-case; the old camelCase ui/openLink is silently
    // ignored by spec-compliant hosts, which broke Tip/View buttons.
    expect(html).toContain("ui/open-link");
    // No camelCase method call remains — the comment may name it, the
    // postMessage payload must not.
    expect(html).not.toContain("method: 'ui/openLink'");
    expect(html).toContain("98% of tips go to the creator");
  });

  it("renders human/agent badges and purpose", () => {
    const html = blockpagePreviewHtml();
    expect(html).toContain("AI Agent");
    expect(html).toContain("Human");
    expect(html).toContain("purpose");
  });

  it("degrades gracefully outside an MCP Apps host", () => {
    const html = blockpagePreviewHtml();
    expect(html).toContain("MCP Apps client");
  });

  it("pins widget links to the given https origin", () => {
    const html = blockpagePreviewHtml(undefined, "https://preview.example.com");
    expect(html).toContain("https://preview.example.com");
    expect(html).not.toContain("https://voicescape.vercel.app");
  });

  it("rejects non-https or foreign origins, falling back to production", () => {
    for (const bad of ["javascript:alert(1)", "http://evil.com", "https://evil.com/x", ""]) {
      const html = blockpagePreviewHtml(undefined, bad);
      expect(html).toContain("https://voicescape.vercel.app");
      expect(html).not.toContain("javascript:");
    }
  });

  it("validates incoming bridge messages (source + shape)", () => {
    const html = blockpagePreviewHtml();
    // Only the embedding host frame may drive the widget.
    expect(html).toContain("event.source !== window.parent");
    // Messages must be JSON-RPC 2.0 with a method string.
    expect(html).toContain("msg.jsonrpc !== '2.0'");
  });

  it("never opens a link off the pinned origin", () => {
    const html = blockpagePreviewHtml();
    expect(html).toContain("url.indexOf(appOrigin + '/') !== 0");
  });

  it("meets the 44px touch target on widget buttons", () => {
    const html = blockpagePreviewHtml();
    expect(html).toContain("min-height: 44px");
  });

  it("completes the SEP-1865 initialize lifecycle", () => {
    const html = blockpagePreviewHtml();
    // Widget announces itself, then waits for the host's answer before
    // declaring readiness — the initialized notification must not fire
    // before the host responds to ui/initialize.
    expect(html).toContain("method: 'ui/initialize'");
    expect(html).toContain("msg.id === INIT_ID");
    expect(html).toContain("method: 'ui/notifications/initialized'");
  });

  it("reports dynamic sizing to the host", () => {
    const html = blockpagePreviewHtml();
    expect(html).toContain("ResizeObserver");
    expect(html).toContain("ui/notifications/size-changed");
  });

  it("listens for tool-input and host-context notifications", () => {
    const html = blockpagePreviewHtml();
    expect(html).toContain("ui/notifications/tool-input");
    expect(html).toContain("ui/notifications/host-context-changed");
  });

  it("surfaces tool errors honestly instead of a dead card", () => {
    const html = blockpagePreviewHtml();
    expect(html).toContain("result.isError === true");
  });

  it("declares a restrictive widget CSP for _meta.ui.csp", () => {
    // Self-contained widget: inline script/style only, no network, no
    // images, no forms — the policy must reflect that, explicitly.
    expect(WIDGET_CSP).toContain("default-src 'none'");
    expect(WIDGET_CSP).toContain("script-src 'unsafe-inline'");
    expect(WIDGET_CSP).toContain("style-src 'unsafe-inline'");
    expect(WIDGET_CSP).toContain("connect-src 'none'");
    expect(WIDGET_CSP).not.toContain("http");
  });
});
