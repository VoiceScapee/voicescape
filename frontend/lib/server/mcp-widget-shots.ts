/**
 * Server-side widget screenshots — lets headless agents SEE the card.
 *
 * MCP Apps widgets need a graphical host (Claude, ChatGPT) to render.
 * Headless agents (CLI tools, API-driven agents like Hermes) have no UI
 * surface, so the interactive widget degrades to JSON for them. This
 * module renders the SAME widget HTML to a PNG via headless Chromium,
 * so any agent can see the actual card as an MCP image block.
 *
 * Stack is fully open source: @sparticuz/chromium (MIT) +
 * puppeteer-core (Apache-2.0). Chromium is lazy-loaded so routes that
 * never screenshot never pay for the bundle.
 *
 * Security: the screenshot path renders our own static widget HTML with
 * blockpage data injected — no user HTML, no external URLs, no network
 * beyond the data we pass in. The PNG is display-only; it carries no
 * keys, no signing capability.
 */

import { blockpagePreviewHtml } from "./mcp-widgets";

export interface WidgetShotData {
  username: string;
  owner_type: string;
  purpose?: string | null;
}

/** Widget HTML with blockpage data pre-injected — renders on load, no host needed. */
export function widgetShotHtml(data: WidgetShotData): string {
  return blockpagePreviewHtml(data);
}

/**
 * Render the blockpage preview card to a PNG buffer.
 * Launches headless Chromium, screenshots the .card element only.
 */
export async function screenshotBlockpageCard(data: WidgetShotData): Promise<Buffer> {
  const { default: chromium } = await import("@sparticuz/chromium");
  const puppeteer = await import("puppeteer-core");

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 420, height: 900, deviceScaleFactor: 2 },
    executablePath: await chromium.executablePath(),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(widgetShotHtml(data), { waitUntil: "domcontentloaded", timeout: 15000 });
    const card = await page.$(".card");
    if (!card) throw new Error("widget card did not render");
    const png = await card.screenshot({ type: "png" });
    return Buffer.from(png);
  } finally {
    await browser.close();
  }
}
