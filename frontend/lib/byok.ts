/**
 * BYOK (bring-your-own-key) Anthropic client for the builder's AI chat.
 *
 * The user's own Anthropic API key is stored ONLY in this browser's
 * localStorage and generation calls go DIRECTLY from the browser to
 * api.anthropic.com — the Voicescape server never sees the key and never
 * pays for a generation. Usage is billed by Anthropic to the key owner.
 *
 * Direct browser access uses Anthropic's documented CORS opt-in header
 * (`anthropic-dangerous-direct-browser-access: true`).
 */
import { isValidPage, type VoicescapePage } from "@/lib/schema";

export const BYOK_STORAGE_KEY = "vs-byok-anthropic-key";
export const BYOK_CONSOLE_URL = "https://platform.claude.com/settings/keys";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_BYOK_MODEL = "claude-sonnet-4-5-20250929";
const MAX_TOKENS = 4096;

/**
 * System prompt constraining the model to output ONLY valid page JSON.
 * The full canonical schema is embedded so templates, editor, renderer,
 * and AI all agree on one source of truth.
 */
export const VIBECODE_SYSTEM_PROMPT = `You are the Voicescape page builder AI. The user describes changes to their personal page, and you return the FULL updated page as JSON.

You must output ONLY a single JSON object. No markdown, no code fences, no explanation, no commentary.

The JSON must match this schema exactly:
{
  "version": 1,
  "username": "string (lowercase letters, numbers, hyphens; never change the username unless the user explicitly asks)",
  "profileSong": { "blockIndex": "number (optional, MySpace-style featured song: indexes into blocks[] then that music block's tracks[])" },
  "theme": {
    "background": "CSS color string",
    "foreground": "CSS color string",
    "accent": "CSS color string",
    "fontFamily": "CSS font-family string"
  },
  "blocks": [
    { "type": "hero", "title": "string", "subtitle": "string (optional)", "avatarEmoji": "single emoji (optional)" },
    { "type": "bio", "text": "string" },
    { "type": "links", "items": [ { "label": "string", "url": "string" } ] },
    { "type": "tipJar", "message": "string (optional)" },
    { "type": "guestbook", "entries": [ { "name": "string", "message": "string", "date": "YYYY-MM-DD string" } ] },
    { "type": "music", "title": "string (optional)", "tracks": [ { "source": "spotify|youtube|soundcloud|ipfs", "id": "embed ID or IPFS CID", "kind": "track|album|playlist|episode|video (optional)", "url": "original URL (optional)", "title": "string (optional)", "artist": "string (optional)" } ], "note": "string (optional, legacy)" },
    { "type": "gallery", "images": ["emoji strings as placeholders"] },
    { "type": "top8", "title": "string (optional)", "friends": [ { "name": "string", "avatarEmoji": "single emoji (optional)", "url": "string (optional)" } ] },
    { "type": "services", "items": [ { "name": "string", "description": "string", "priceUsdCents": "number (integer, USD cents)", "endpoint": "string (URL)" } ] },
    { "type": "capabilities", "items": ["machine-readable tag strings, e.g. summarization"] },
    { "type": "operator", "wallet": "string (0x address)", "name": "string (optional)", "url": "string (optional)" },
    { "type": "reviews", "title": "string (optional)", "entries": [ { "name": "string", "message": "string", "date": "YYYY-MM-DD string", "txHash": "string (optional, payment proof)" } ] },
    { "type": "booking", "title": "string (optional)", "items": [ { "label": "string", "url": "string", "note": "string (optional)" } ] }
  ]
}

Rules:
- "version" must be 1. "type" must be one of: hero, bio, links, tipJar, guestbook, music, gallery, top8, services, capabilities, operator, reviews, booking.
- For agent pages (page.ownerType === "agent"), NEVER remove the operator disclosure or the page's agent identity; keep the agent/human distinction unmistakable.
- Service prices are always integer USD cents (priceUsdCents).
- Apply ONLY the change the user asked for; preserve everything else from the current page JSON.
- For "gallery" and "top8" blocks use emoji placeholders only — never real URLs or embeds.
- "music" blocks use real tracks: "source" is one of spotify|youtube|soundcloud|ipfs, "id" is the platform embed ID (or IPFS CID for the owner's own upload). Never invent track IDs — only use links the user provided. "profileSong" (page level, optional) is { "blockIndex": number, "trackIndex": number }, the MySpace-style featured song.
- Never invent usernames, real people, or external URLs beyond what the user provided.
- Keep text concise and in the spirit of the request.`;

export class ByokError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ByokError";
  }
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The user's own Anthropic key, or null when not set. Browser-only. */
export function getByokKey(): string | null {
  const s = storage();
  if (!s) return null;
  const v = s.getItem(BYOK_STORAGE_KEY);
  return v && v.trim() ? v.trim() : null;
}

export function hasByokKey(): boolean {
  return getByokKey() !== null;
}

/** Store the user's Anthropic key in this browser only. Never sent to our server. */
export function setByokKey(key: string): void {
  const s = storage();
  if (!s) throw new ByokError("Browser storage is unavailable — cannot save the key.");
  const trimmed = key.trim();
  if (!trimmed) throw new ByokError("The key is empty.");
  s.setItem(BYOK_STORAGE_KEY, trimmed);
}

export function clearByokKey(): void {
  storage()?.removeItem(BYOK_STORAGE_KEY);
}

export interface ByokGenerateOptions {
  pageJson: unknown;
  instruction: string;
  apiKey: string;
  model?: string;
}

/**
 * Generate an updated page JSON by calling Anthropic DIRECTLY from the
 * browser with the user's own key. The Voicescape server is not involved —
 * no request, no proxy, no spend on our side. Billed by Anthropic to the
 * key owner.
 */
export async function generatePageWithByokKey(
  opts: ByokGenerateOptions,
): Promise<VoicescapePage> {
  const { pageJson, instruction, apiKey, model } = opts;
  const key = apiKey.trim();
  if (!key) throw new ByokError("No Anthropic API key set. Add your key in the AI key settings first.");
  if (!instruction.trim()) throw new ByokError("Describe the change first.");

  const userContent =
    `Current page JSON:\n${JSON.stringify(pageJson)}\n\nRequested change:\n${instruction}\n\nReturn the full updated page JSON only.`;

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
        // Anthropic's documented opt-in for direct browser → api.anthropic.com calls.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: model || DEFAULT_BYOK_MODEL,
        max_tokens: MAX_TOKENS,
        system: VIBECODE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });
  } catch (e) {
    throw new ByokError(
      `Could not reach api.anthropic.com: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new ByokError(
        "Anthropic rejected your API key (401). Check the key in the AI key settings — it starts with sk-ant-.",
      );
    }
    if (res.status === 402 || res.status === 429) {
      throw new ByokError(
        `Anthropic refused the request (${res.status}): ${text.slice(0, 200) || "billing or rate limit"}. This is between you and Anthropic — Voicescape never touches billing.`,
      );
    }
    throw new ByokError(`Anthropic API error (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    content?: { type?: string; text?: string }[];
  };
  const textBlock = data.content?.find((b) => b.type === "text" && typeof b.text === "string");
  const raw = (textBlock?.text ?? "").trim();
  if (!raw) throw new ByokError("Anthropic returned no text content.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ByokError("The model did not return valid JSON. Try rephrasing your instruction.");
  }

  if (!isValidPage(parsed)) {
    throw new ByokError(
      "The model returned JSON that does not match the page schema. Try rephrasing your instruction.",
    );
  }

  return parsed;
}
