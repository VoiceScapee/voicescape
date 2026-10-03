/**
 * GET /api/mcp/widget-shot?username=<name> — blockpage preview card as PNG.
 *
 * Serves headless agents (CLI tools, API-driven agents) that cannot render
 * MCP Apps widgets: they get the SAME card as an image instead of JSON.
 * Called by the `render_blockpage_image` MCP tool; not for browsers.
 *
 * Separate function from /api/mcp on purpose: the Chromium bundle stays
 * out of the MCP route so the other 16 tools never pay for it.
 *
 * Guards: per-IP rate limit (screenshots are CPU-heavy), username format
 * validation, 10-minute KV cache keyed by username.
 */

export const runtime = "nodejs";
export const maxDuration = 30;

import { lookupBlockpage } from "@/lib/server/mcp-tools";
import { screenshotBlockpageCard } from "@/lib/server/mcp-widget-shots";
import { checkIpRateLimit, clientIpFromHeaders } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";

const SHOT_IP_LIMIT = 10;
const SHOT_IP_WINDOW_MS = 3_600_000; // 1 hour
const CACHE_TTL_MS = 600_000; // 10 minutes

export async function GET(req: Request): Promise<Response> {
  const username = (new URL(req.url).searchParams.get("username") ?? "").trim().toLowerCase();

  // Cheap gates first: rate limit, then username format.
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
      { error: "widget-shot rate limit exceeded: 10 requests/hour per IP" },
      { status: 429 },
    );
  }
  if (!username || username.length > 64) {
    return Response.json({ error: "username is required" }, { status: 400 });
  }

  const kv = getKvStore();
  const cacheKey = `widget-shot:v1:${username}`;

  // Serve from cache when fresh — screenshots are expensive.
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

  // Real on-chain lookup; unknown names 404 like lookup_blockpage's found=false.
  const bp = await lookupBlockpage(username);
  if (!bp.found) {
    return Response.json({ error: `blockpage not found: ${username}` }, { status: 404 });
  }

  let png: Buffer;
  try {
    png = await screenshotBlockpageCard({
      username: bp.username,
      owner_type: bp.owner_type ?? "human",
      purpose: bp.purpose ?? "",
    });
  } catch (e) {
    console.error(JSON.stringify({ widget_shot: "render_failed", username, err: String(e).slice(0, 200) }));
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
