import { describe, it, expect } from "vitest";
import { blockpagePreviewHtml } from "./mcp-widgets";
import { widgetShotHtml } from "./mcp-widget-shots";

describe("blockpagePreviewHtml preload", () => {
  it("embeds preloaded data without a postMessage wait", () => {
    const html = blockpagePreviewHtml({
      username: "user-10424063",
      owner_type: "human",
      purpose: "Founder page",
    });
    expect(html).toContain("__VOICESCAPE_PRELOAD__");
    expect(html).toContain("user-10424063");
    // Renders immediately on load when preload is present.
    expect(html).toContain("if (window.__VOICESCAPE_PRELOAD__");
  });

  it("escapes < in preloaded data to prevent script breakout", () => {
    const html = blockpagePreviewHtml({
      username: "x",
      owner_type: "human",
      purpose: "</script><script>alert(1)</script>",
    });
    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c");
  });

  it("without preload keeps the host handshake path", () => {
    const html = blockpagePreviewHtml();
    expect(html).toContain("window.__VOICESCAPE_PRELOAD__ = null");
    expect(html).toContain("ui/initialize");
  });
});

describe("widgetShotHtml", () => {
  it("produces the same card markup as the interactive widget", () => {
    const shot = widgetShotHtml({ username: "thechomps", owner_type: "agent", purpose: "test" });
    const live = blockpagePreviewHtml({ username: "thechomps", owner_type: "agent", purpose: "test" });
    expect(shot).toBe(live);
  });
});
