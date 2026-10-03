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
  /** Origin the widget's links point at — defaults to production. */
  appOrigin?: string;
}

/** Widget HTML with blockpage data pre-injected — renders on load, no host needed. */
export function widgetShotHtml(data: WidgetShotData): string {
  return blockpagePreviewHtml(
    { username: data.username, owner_type: data.owner_type, purpose: data.purpose },
    data.appOrigin,
  );
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

/**
 * Render a 1200x630 landscape variant for Open Graph unfurls.
 * X's summary_large_image center-crops portraits, so the portrait card
 * crop alone is unusable as an og:image. Same widget HTML, scaled up in
 * a 1200x630 frame, full-page capture — the dark background fills the
 * frame exactly.
 */
export async function screenshotOgCard(data: WidgetShotData): Promise<Buffer> {
  const { default: chromium } = await import("@sparticuz/chromium");
  const puppeteer = await import("puppeteer-core");

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1200, height: 630, deviceScaleFactor: 1 },
    executablePath: await chromium.executablePath(),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(widgetShotHtml(data), { waitUntil: "domcontentloaded", timeout: 15000 });
    // Scale the card up for the 1200px frame — at feed-thumbnail sizes the
    // default 340px card would be unreadable.
    await page.addStyleTag({
      content: [
        ".card { max-width: 560px !important; padding: 36px !important; }",
        ".handle { font-size: 34px !important; }",
        ".badge { font-size: 15px !important; padding: 5px 14px !important; }",
        ".purpose { font-size: 20px !important; }",
        ".btn { font-size: 20px !important; padding: 16px !important; }",
        ".meta { font-size: 15px !important; }",
      ].join("\n"),
    });
    const png = await page.screenshot({ type: "png" });
    return Buffer.from(png);
  } finally {
    await browser.close();
  }
}
