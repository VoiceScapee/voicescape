/**
 * MCP Apps widget tests — blockpage preview card.
 *
 * Verifies the widget HTML is self-contained, sandboxed-safe (no key
 * handling, no signing), and carries the MCP Apps MIME profile.
 */
import { describe, expect, it } from "vitest";
import { BLOCKPAGE_PREVIEW_URI, blockpagePreviewHtml } from "./mcp-widgets";

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

  it("hands money actions off via openLink (wallet stays the authority)", () => {
    const html = blockpagePreviewHtml();
    expect(html).toContain("ui/openLink");
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
});
