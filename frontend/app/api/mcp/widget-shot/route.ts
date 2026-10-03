/**
 * GET /api/mcp/widget-shot?username=<name>[&format=og] — blockpage preview card as PNG.
 *
 * Serves headless agents (CLI tools, API-driven agents) that cannot render
 * MCP Apps widgets: they get the SAME card as an image instead of JSON.
 * Called by the `render_blockpage_image` MCP tool; not for browsers.
 *
 * format=card (default): portrait card crop — what the agent sees.
 * format=og: 1200x630 landscape full-page shot — the Open Graph image for
 *   blockpage link unfurls (X summary_large_image center-crops portraits).
 *
 * Separate function from /api/mcp on purpose: the Chromium bundle stays
 * out of the MCP route so the other tools never pay for it.
 *
 * Guards: username format validation, 10-minute KV cache keyed by
 * username+format, per-IP rate limit (10/hour) on cache MISSES only —
 * scraper re-fetches must not burn the screenshot budget.
 */

export const runtime = "nodejs";
export const maxDuration = 30;

import { lookupBlockpage } from "@/lib/server/mcp-tools";
import {
  screenshotBlockpageCard,
  widgetShotHtml,
  type WidgetShotData,
} from "@/lib/server/mcp-widget-shots";
import { checkIpRateLimit, clientIpFromHeaders } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";

const SHOT_IP_LIMIT = 10;
const SHOT_IP_WINDOW_MS = 3_600_000; // 1 hour
const CACHE_TTL_MS = 600_000; // 10 minutes

/**
 * 1200x630 landscape render for Open Graph unfurls. Kept here (not in
 * mcp-widget-shots.ts) because it needs a different viewport AND a
 * full-page capture instead of the card-element crop — the shared
 * screenshotBlockpageCard only does the portrait card.
 */
async function screenshotOgCard(data: WidgetShotData): Promise<Buffer> {
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
    // Full page: the widget body centers the card on the dark background,
    // which fills the 1200x630 frame exactly.
    const png = await page.screenshot({ type: "png" });
    return Buffer.from(png);
  } finally {
    await browser.close();
  }
}

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const username = (params.get("username") ?? "").trim().toLowerCase();
  const format = (params.get("format") ?? "card").trim().toLowerCase();

  // Username format is free to check — validate before any shared budget.
  if (!username || username.length > 64) {
    return Response.json({ error: "username is required" }, { status: 400 });
  }
  if (format !== "card" && format !== "og") {
    return Response.json({ error: "format must be card or og" }, { status: 400 });
  }

  const kv = getKvStore();
  const cacheKey = `widget-shot:v1:${format}:${username}`;

  // Cache FIRST: scraper re-fetches and repeat agent views cost a KV GET,
  // never screenshot CPU and never rate-limit budget.
  try {
    const cached = await kv.get(cacheKey);
    if (cached) {
      return new Response(Buffer.from(cached, "base64"), {
        headers: { "Content-Type": "image/png", "X-Widget-Shot-Cache": "hit" },
      });
    }
  } catch {
    /* cache miss or KV down — render anyway */
  }

  // Rate limit applies to renders only (cache misses).
  let rl;
  try {
    rl = await checkIpRateLimit(
      clientIpFromHeaders(req.headers),
      "mcp-widget-shot",
      SHOT_IP_LIMIT,
      SHOT_IP_WINDOW_MS,
    );
  } catch {
    return Response.json({ error: "temporarily unavailable — please retry in a moment" }, { status: 503 });
  }
  if (!rl.allowed) {
    return Response.json(
      { error: "widget-shot rate limit exceeded: 10 renders/hour per IP" },
      { status: 429 },
    );
  }

  // Real on-chain lookup; unknown names 404 like lookup_blockpage's found=false.
  const bp = await lookupBlockpage(username);
  if (!bp.found) {
    return Response.json({ error: `blockpage not found: ${username}` }, { status: 404 });
  }

  const data: WidgetShotData = {
    username: bp.username,
    owner_type: bp.owner_type ?? "human",
    purpose: bp.purpose ?? "",
  };

  let png: Buffer;
  try {
    png = format === "og" ? await screenshotOgCard(data) : await screenshotBlockpageCard(data);
  } catch (e) {
    console.error(JSON.stringify({ widget_shot: "render_failed", username, format, err: String(e).slice(0, 200) }));
    return Response.json({ error: "could not render preview — please retry" }, { status: 500 });
  }

  // Best-effort cache; a KV failure never blocks the response.
  try {
    await kv.set(cacheKey, png.toString("base64"), CACHE_TTL_MS);
  } catch {
    /* ignore */
  }

  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "X-Widget-Shot-Cache": "miss" },
  });
}
