/**
 * POST /api/page-voice — per-blockpage voice mic agent (production).
 *
 * A page-scoped voice loop for every blockpage: the visitor speaks (or
 * types), the agent answers about THIS page from its live blocks, and can
 * scroll to a block or open the tip box. Read-only: no auth, no wallet, no
 * signing, no chain writes. Money movement always hands off to the page's
 * own tip flow, approved in the visitor's wallet.
 *
 * Cost: $0 marginal. Speech in/out is the browser's Web Speech API; intent
 * matching is a deterministic router over the page's real blocks; the
 * free-tier AI planner is only a fallback for unmatched prompts, and the
 * router's capability list is the fallback after that. The mic never dies
 * and never spends anything.
 *
 * Body: { transcript, lang (2-letter), username, navigatorLang? }
 * Returns: { ok, speak, steps, action?: { scrollTo?, openTip? } }
 */

import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { ipGate } from "@/lib/server/rate-limit";
import { mirrorContractCall } from "@/lib/tx";
import { CHAINS } from "@/lib/chains";
import { fetchPageJson } from "@/lib/ipfs";
import { fetchWithTimeout } from "@/lib/fetch-timeout";
import { parseYouTubeLiveStatus, isYouTubeChannelId } from "@/lib/youtube-live";
import { type Lang } from "@/lib/i18n/dictionaries";
import {
  capabilityReply,
  matchIntent,
  resolveLang,
  t,
  truncateSentence,
  type IntentDef,
} from "@/lib/server/page-voice-intent";

export const runtime = "nodejs";

/** Same resolve path as /api/resolve (canonical source for these values). */
const REGISTRY_ABI = [
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
];
const REGISTRY_EVM = "0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58";
const REGISTRY_IFACE = new ethers.Interface(REGISTRY_ABI);

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
const MAX_TRANSCRIPT = 500;

/** Fields that stay server-side — never spoken or returned. */
const SENSITIVE_KEYS = new Set([
  "owner_evm",
  "owner_account",
  "ownerEvm",
  "operator",
  "ipfs_hash",
  "ipfsHash",
  "wallet",
  "account_id",
]);

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k)) continue;
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

interface PageBlock {
  type: string;
  title?: string;
  subtitle?: string;
  text?: string;
  message?: string;
  note?: string;
  platform?: string;
  channel?: string;
  tracks?: Array<{ title?: string }>;
  items?: Array<{ label?: string; url?: string; note?: string }>;
  images?: unknown[];
}

interface VoicePage {
  username: string;
  displayName: string;
  blocks: PageBlock[];
}

export type VoiceAction = { scrollTo?: string; openTip?: boolean };

export interface VoiceReply {
  ok: boolean;
  speak: string;
  steps: string[];
  action?: VoiceAction;
}

/* ------------------------------------------------------------------ */
/* Page fetch: resolve -> IPFS (same path as /api/resolve)              */
/* ------------------------------------------------------------------ */

async function fetchVoicePage(username: string): Promise<VoicePage | null> {
  try {
    const data = REGISTRY_IFACE.encodeFunctionData("resolvePage", [username]);
    const raw = await mirrorContractCall(CHAINS["hedera-mainnet"], REGISTRY_EVM, data);
    const [, ipfsHash] = REGISTRY_IFACE.decodeFunctionResult("resolvePage", raw) as unknown as [
      string,
      string,
      bigint,
      string,
      string,
    ];
    if (!ipfsHash) return null;
    const text = await fetchPageJson(ipfsHash);
    const page = sanitize(JSON.parse(text)) as {
      blocks?: PageBlock[];
      username?: string;
    };
    const blocks = Array.isArray(page.blocks) ? page.blocks : [];
    const hero = blocks.find((b) => b.type === "hero");
    return {
      username,
      displayName: hero?.title || page.username || username,
      blocks,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Narration (templates live here; intent matching in page-voice-intent) */
/* ------------------------------------------------------------------ */

async function youTubeLive(channel: string | undefined): Promise<boolean> {
  if (!channel || !isYouTubeChannelId(channel)) return false;
  try {
    const res = await fetchWithTimeout(`https://www.youtube.com/channel/${channel}/live`, 10_000, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });
    if (!res.ok) return false;
    return parseYouTubeLiveStatus(await res.text()).live;
  } catch {
    return false; // offline-first: any failure means "not live"
  }
}

async function answerIntent(
  intent: IntentDef,
  page: VoicePage,
  lang: Lang,
): Promise<{ speak: string; steps: string[]; action?: VoiceAction }> {
  const name = page.displayName;
  const blocks = page.blocks;
  switch (intent.id) {
    case "music": {
      const block = blocks.find((b) => b.type === "music");
      const trackCount = block?.tracks?.length ?? 0;
      const detail =
        trackCount > 0
          ? t(lang, ` ${trackCount} track${trackCount === 1 ? "" : "s"}.`, ` ${trackCount} pista${trackCount === 1 ? "" : "s"}.`)
          : "";
      return {
        speak: t(
          lang,
          `Here's ${name}'s music — it's just below.${detail}`,
          `Esta es la música de ${name} — está aquí abajo.${detail}`,
        ),
        steps: [t(lang, "Found the music block", "Encontré el bloque de música")],
        action: { scrollTo: "music" },
      };
    }
    case "livestream": {
      const block = blocks.find((b) => b.type === "livestream");
      if (block?.platform === "youtube") {
        const live = await youTubeLive(block.channel);
        if (live) {
          return {
            speak: t(
              lang,
              `${name} is live right now — the stream is playing below.`,
              `${name} está en vivo ahora mismo — el stream está sonando abajo.`,
            ),
            steps: [t(lang, "They're live — scrolled to the stream", "Están en vivo — bajé al stream")],
            action: { scrollTo: "livestream" },
          };
        }
        return {
          speak: t(
            lang,
            `${name} isn't live right now — check back for the next stream.`,
            `${name} no está en vivo ahora mismo — vuelve para el próximo stream.`,
          ),
          steps: [t(lang, "Checked the stream — not live", "Revisé el stream — no está en vivo")],
        };
      }
      // Twitch (or unknown): no live probe available — never claim live.
      return {
        speak: t(
          lang,
          `${name}'s stream is linked just below.`,
          `El stream de ${name} está enlazado aquí abajo.`,
        ),
        steps: [t(lang, "Scrolled to the stream block", "Bajé al bloque del stream")],
        action: { scrollTo: "livestream" },
      };
    }
    case "bio": {
      const hero = blocks.find((b) => b.type === "hero");
      const bio = blocks.find((b) => b.type === "bio" && b.text);
      const summary = bio?.text
        ? truncateSentence(bio.text)
        : hero?.subtitle
          ? truncateSentence(`${hero.title ?? name} — ${hero.subtitle}`)
          : t(lang, `${name}'s page on Voicescape.`, `La página de ${name} en Voicescape.`);
      return {
        speak: summary,
        steps: [t(lang, "Read their story from the page", "Leí su historia de la página")],
      };
    }
    case "links": {
      return {
        speak: t(
          lang,
          `Here are ${name}'s links — they're just below.`,
          `Aquí están los enlaces de ${name} — están aquí abajo.`,
        ),
        steps: [t(lang, "Found their links", "Encontré sus enlaces")],
        action: { scrollTo: intent.scrollTo },
      };
    }
    case "gallery": {
      const count = blocks
        .filter((b) => b.type === "gallery")
        .reduce((n, b) => n + (b.images?.length ?? 0), 0);
      const detail = count > 0 ? t(lang, ` ${count} photos.`, ` ${count} fotos.`) : "";
      return {
        speak: t(
          lang,
          `Here's ${name}'s gallery — take a look below.${detail}`,
          `Esta es la galería de ${name} — mírala abajo.${detail}`,
        ),
        steps: [t(lang, "Found their gallery", "Encontré su galería")],
        action: { scrollTo: "gallery" },
      };
    }
    case "tip": {
      return {
        speak: t(
          lang,
          `I can open the tip box for you — you approve everything in your own wallet, nothing moves until you say so.`,
          `Puedo abrir la caja de propinas — tú apruebas todo en tu propia billetera, nada se mueve sin tu aprobación.`,
        ),
        steps: [t(lang, "Opening the tip box", "Abriendo la caja de propinas")],
        action: { openTip: true },
      };
    }
    case "booking": {
      const block = blocks.find((b) => b.type === "booking");
      const labels = (block?.items ?? [])
        .map((i) => i.label)
        .filter((l): l is string => !!l)
        .slice(0, 4);
      const detail =
        labels.length > 0
          ? t(lang, ` Options: ${labels.join(", ")}.`, ` Opciones: ${labels.join(", ")}.`)
          : "";
      return {
        speak: t(
          lang,
          `Here's how to book ${name}.${detail}`,
          `Así puedes reservar con ${name}.${detail}`,
        ),
        steps: [t(lang, "Read their booking options", "Leí sus opciones de reserva")],
        action: { scrollTo: "booking" },
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Fallbacks: free-tier AI planner, then the honest capability list     */
/* ------------------------------------------------------------------ */

function cleanJson(raw: string): string {
  const s = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}

async function aiFallback(
  transcript: string,
  page: VoicePage,
  lang: Lang,
): Promise<{ speak: string; steps: string[] } | null> {
  const blockTypes = [...new Set(page.blocks.map((b) => b.type))].join(", ");
  const system =
    `You are the voice assistant for the Voicescape blockpage "${page.username}" ` +
    `(display name: ${page.displayName}). Its blocks: ${blockTypes}. ` +
    `Answer briefly about this page in ${lang === "es" ? "Spanish" : "English"}. ` +
    `Reply with JSON ONLY: {"speak":"1-2 sentences","steps":["..."]}. ` +
    `Never invent blocks the page doesn't have. Never handle money or wallets — ` +
    `if asked about tipping, say the tip box opens in their own wallet.`;
  try {
    const res = await fetchWithTimeout("https://text.pollinations.ai/openai", 25_000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai",
        messages: [
          { role: "system", content: system },
          { role: "user", content: transcript.slice(0, MAX_TRANSCRIPT) },
        ],
        max_tokens: 512,
        temperature: 0.5,
      }),
    });
    if (!res.ok) return null;
    const parsed = JSON.parse(cleanJson((await res.json())?.choices?.[0]?.message?.content ?? ""));
    if (typeof parsed.speak !== "string" || !parsed.speak.trim()) return null;
    return {
      speak: parsed.speak.slice(0, 500),
      steps: Array.isArray(parsed.steps) ? parsed.steps.slice(0, 4).map((s: unknown) => String(s)) : [],
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gated = await ipGate(
    req,
    "page-voice",
    "IP_RATE_LIMIT_PAGE_VOICE",
    300,
    "too many voice requests from this network — try again later",
  );
  if (gated) return gated;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const { transcript, lang, username, navigatorLang } = (body ?? {}) as {
    transcript?: unknown;
    lang?: unknown;
    username?: unknown;
    navigatorLang?: unknown;
  };

  const spoken = typeof transcript === "string" ? transcript.trim().slice(0, MAX_TRANSCRIPT) : "";
  if (!spoken) {
    return NextResponse.json({ ok: false, error: "empty transcript" }, { status: 400 });
  }
  const name = typeof username === "string" ? username.trim().toLowerCase() : "";
  if (!USERNAME_RE.test(name)) {
    return NextResponse.json({ ok: false, error: "invalid username" }, { status: 400 });
  }
  const useLang = resolveLang(lang, navigatorLang);

  const page = await fetchVoicePage(name);
  if (!page || page.blocks.length === 0) {
    const reply: VoiceReply = {
      ok: true,
      speak: t(
        useLang,
        "This page isn't loading right now — try again in a moment.",
        "Esta página no está cargando ahora mismo — inténtalo de nuevo en un momento.",
      ),
      steps: [],
    };
    return NextResponse.json(reply);
  }

  const blockTypes = new Set(page.blocks.map((b) => b.type));

  // 1. Deterministic router first — no model, no cost, never down.
  const intent = matchIntent(spoken, blockTypes);
  if (intent) {
    const answered = await answerIntent(intent, page, useLang);
    const reply: VoiceReply = { ok: true, ...answered };
    return NextResponse.json(reply);
  }

  // 2. Free-tier AI planner for everything else, scoped to this page.
  const ai = await aiFallback(spoken, page, useLang);
  if (ai) {
    const reply: VoiceReply = { ok: true, ...ai };
    return NextResponse.json(reply);
  }

  // 3. Honest capability list from the page's real blocks.
  const reply: VoiceReply = { ok: true, ...capabilityReply(blockTypes, useLang) };
  return NextResponse.json(reply);
}
