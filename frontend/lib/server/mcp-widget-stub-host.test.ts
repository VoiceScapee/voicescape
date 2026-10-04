/**
 * Stub MCP Apps host — protocol-side verification of the blockpage widget.
 *
 * A graphical host (Claude, ChatGPT) is still the gold standard and remains
 * unverified. This harness verifies everything up to the host boundary: it
 * loads the real widget HTML in headless Chromium inside an iframe, plays
 * the host side of the SEP-1865 postMessage handshake, drives a tool-result
 * through, clicks both buttons, and asserts every JSON-RPC method the widget
 * emits against the spec allowlist.
 *
 * What this catches: wrong method names (a spec-compliant host silently
 * ignores unknown methods), broken handshake sequencing, un-pinned URLs.
 * What it does not catch: host-specific rendering quirks.
 *
 * Stack mirrors the production screenshot path: @sparticuz/chromium +
 * puppeteer-core.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { blockpagePreviewHtml } from "./mcp-widgets";

/** SEP-1865 methods the widget is allowed to emit (view -> host). */
const WIDGET_TO_HOST_ALLOWLIST = new Set([
  "ui/initialize",
  "ui/notifications/initialized",
  "ui/notifications/size-changed",
  "ui/open-link",
]);

const APP_ORIGIN = "https://voicescape.vercel.app";
const INIT_ID = "voicescape-init-1";

interface WidgetMsg {
  jsonrpc: string;
  id?: string | number;
  method?: string;
  params?: { url?: string };
}

const HOST_PAGE = `<html><body><script>
  window.__msgs = [];
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    window.__msgs.push(m);
    // Play the host side of the SEP-1865 handshake.
    if (m.method === 'ui/initialize') {
      e.source.postMessage(
        { jsonrpc: '2.0', id: m.id, result: { hostContext: { theme: 'dark' } } },
        '*',
      );
    }
    // After the widget confirms initialized, deliver a tool result.
    if (m.method === 'ui/notifications/initialized') {
      e.source.postMessage(
        {
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-result',
          params: {
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    username: 'stubbot',
                    owner_type: 'agent',
                    purpose: 'stub host protocol test',
                  }),
                },
              ],
            },
          },
        },
        '*',
      );
    }
  });
</script></body></html>`;

describe("stub host: widget protocol", () => {
  let browser: any;

  beforeAll(async () => {
    const { default: chromium } = await import("@sparticuz/chromium");
    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 420, height: 900 },
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
  });

  it("handshakes, renders on tool-result, and emits spec-correct open-link", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(HOST_PAGE, { waitUntil: "domcontentloaded" });
      // Embed the REAL widget HTML (handshake path — no preload) in an iframe,
      // the way a host embeds it.
      await page.evaluate((html: string) => {
        const f = document.createElement("iframe");
        f.id = "widget";
        f.srcdoc = html;
        document.body.appendChild(f);
      }, blockpagePreviewHtml());

      await page.waitForSelector("#widget", { timeout: 10000 });
      const widgetEl = await page.$("#widget");
      const frame = await widgetEl!.contentFrame();
      expect(frame, "widget iframe did not attach").toBeTruthy();

      // The card renders once the stub host delivers the tool result.
      await frame!.waitForFunction(
        () => {
          const card = document.querySelector(".card");
          return !!card && !card.querySelector(".loading");
        },
        { timeout: 20000 },
      );
      const handle = await frame!.$(".handle");
      expect(await handle!.evaluate((el: any) => el.textContent)).toContain(
        "stubbot",
      );

      // Click both buttons; the widget must ask the host to open links.
      await frame!.click("#tipBtn");
      await frame!.click("#viewBtn");
      await page.waitForFunction(
        () =>
          (window as any).__msgs.filter(
            (m: any) => m.method === "ui/open-link",
          ).length >= 2,
        { timeout: 10000 },
      );

      const msgs = (await page.evaluate(
        () => (window as any).__msgs,
      )) as WidgetMsg[];

      // 1. Every emitted method is on the SEP-1865 allowlist.
      for (const m of msgs) {
        expect(
          m.method && WIDGET_TO_HOST_ALLOWLIST.has(m.method),
          `widget emitted non-spec method: ${m.method}`,
        ).toBe(true);
      }

      // 2. Handshake order: initialize -> initialized.
      const methods = msgs.map((m) => m.method);
      expect(methods[0]).toBe("ui/initialize");
      expect(methods).toContain("ui/notifications/initialized");
      const initMsg = msgs.find((m) => m.method === "ui/initialize");
      expect(initMsg!.id).toBe(INIT_ID);

      // 4. Bridge-state diagnostics progress to live.
      const bridgeState = await frame!.evaluate(
        () => (window as any).__VOICESCAPE_BRIDGE_STATE__,
      );
      expect(bridgeState).toBe("live");
      const diagEl = await frame!.$("#bridgeDiag");
      expect(diagEl, "diagnostic footer missing").toBeTruthy();
      expect(await diagEl!.evaluate((el: any) => el.textContent)).toContain(
        "bridge: live",
      );
      // 3. Both buttons emitted kebab-case ui/open-link with origin-pinned URLs.
      const opens = msgs.filter((m) => m.method === "ui/open-link");
      expect(opens.length).toBeGreaterThanOrEqual(2);
      for (const o of opens) {
        expect(o.params?.url).toMatch(new RegExp(`^${APP_ORIGIN.replace(/\./g, "\\.")}/`));
      }
      expect(opens.some((o) => o.params?.url?.includes("?tip=1"))).toBe(true);
      // No camelCase leakage, ever.
      expect(JSON.stringify(msgs)).not.toContain("ui/openLink");
    } finally {
      await page.close();
    }
  }, 90000);
});
