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
import { screenshotBlockpageCard, screenshotOgCard } from "@/lib/server/mcp-widget-shots";
import { checkIpRateLimit, clientIpFromHeaders } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";

const SHOT_IP_LIMIT = 10;
const SHOT_IP_WINDOW_MS = 3_600_000; // 1 hour
const CACHE_TTL_MS = 600_000; // 10 minutes

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

  // Per-IP gate on cache MISSES only — screenshots are CPU-heavy.
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
    const retryAfterSec = Math.max(1, Math.ceil((rl.retryAfterMs ?? 3_600_000) / 1000));
    return Response.json(
      {
        error: "widget-shot rate limit exceeded: 10 requests/hour per IP",
        retryAfterMs: rl.retryAfterMs,
      },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
    );
  }

  // Real on-chain lookup; unknown names 404 like lookup_blockpage's found=false.
  const bp = await lookupBlockpage(username);
  if (!bp.found) {
    return Response.json({ error: `blockpage not found: ${username}` }, { status: 404 });
  }

  let png: Buffer;
  try {
    const data = {
      username: bp.username,
      owner_type: bp.owner_type ?? "human",
      purpose: bp.purpose ?? "",
      appOrigin: new URL(req.url).origin,
    };
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
