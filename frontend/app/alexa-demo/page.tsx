"use client";

/**
 * /alexa-demo — Voicescape Voice Builder (hackathon demo).
 *
 * Simulated Alexa+ experience for the Amazon Build, Ship, Shape hackathon:
 * speak a prompt, the agent plans over our LIVE MCP server and a blockpage
 * preview builds itself on screen. Demo branch only — never merged to master.
 * No wallet, no claiming, no money movement: the result is a preview draft.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

// Minimal Web Speech API typings (browser-provided, no dependency).
interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

interface ToolResult {
  tool: string;
  result: unknown;
}
interface AgentResponse {
  speak: string;
  steps: string[];
  toolResults: ToolResult[];
  pageDraft: {
    displayName?: string;
    purpose?: string;
    theme?: { background?: string; foreground?: string; accent?: string; fontFamily?: string };
    socials?: Array<{ platform: string; url: string }>;
    links?: Array<{ label: string; url: string }>;
    // Real blockpage blocks (hero, bio, music, livestream, tipJar, links,
    // gallery) or the planner's simple {type, content} shape.
    blocks?: Array<Record<string, unknown>>;
  };
  mcp?: { endpoint: string; protocolVersion: string; serverName: string };
  disclaimer?: string;
  error?: string;
}

/**
 * Render one real blockpage block. The livestream block embeds the actual
 * YouTube live player — real video playing inside the preview.
 */
function BlockView({ block, accent }: { block: Record<string, unknown>; accent: string }) {
  const type = block.type as string;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (type === "hero") {
    return (
      <div style={{ padding: 24, textAlign: "center" }}>
        <div
          style={{
            margin: "0 auto",
            display: "flex",
            width: 64,
            height: 64,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 9999,
            fontSize: 30,
            background: `${accent}26`,
            color: accent,
          }}
        >
          {str(block.avatarEmoji) || "🎸"}
        </div>
        <h3 style={{ marginTop: 12, fontSize: 20, fontWeight: 700 }}>{str(block.title) || "Your page"}</h3>
        {str(block.subtitle) && <p style={{ marginTop: 4, fontSize: 14, opacity: 0.7 }}>{str(block.subtitle)}</p>}
      </div>
    );
  }
  if (type === "bio") {
    return <p style={{ padding: "8px 24px", textAlign: "center", fontSize: 14, opacity: 0.8 }}>{str(block.text)}</p>;
  }
  if (type === "music") {
    const tracks = Array.isArray(block.tracks) ? block.tracks : [];
    return (
      <div style={{ margin: "12px 16px 0", borderRadius: 8, padding: "12px 16px", fontSize: 14, background: `${accent}14` }}>
        <p style={{ fontWeight: 600 }}>🎶 {str(block.title) || "Music"}</p>
        {str(block.note) && <p style={{ marginTop: 4, opacity: 0.7 }}>{str(block.note)}</p>}
        {tracks.map((t, i) => (
          <p key={i} style={{ marginTop: 4, opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            ▶ {str((t as Record<string, unknown>).title) || str(t)}
          </p>
        ))}
      </div>
    );
  }
  if (type === "livestream" && block.platform === "youtube" && str(block.channel)) {
    // Prefer the resolved direct video ID (reliable); fall back to the
    // channel resolver embed.
    const videoId = str(block.videoId);
    const src = videoId
      ? `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&rel=0`
      : `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(str(block.channel))}&autoplay=1&mute=1&rel=0`;
    return (
      <div style={{ margin: "12px 16px 0", overflow: "hidden", borderRadius: 8, border: `1px solid ${accent}44` }}>
        <div style={{ aspectRatio: "16/9", width: "100%" }}>
          <iframe
            style={{ height: "100%", width: "100%", border: "none" }}
            src={src}
            title={str(block.title) || "Live stream"}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        </div>
        {str(block.title) && (
          <p style={{ padding: "8px 12px", textAlign: "center", fontSize: 12, fontWeight: 600, color: accent }}>
            🔴 {str(block.title)}
          </p>
        )}
      </div>
    );
  }
  if (type === "tipJar") {
    return (
      <div
        style={{
          margin: "12px 16px 0",
          borderRadius: 8,
          padding: "12px 16px",
          textAlign: "center",
          fontSize: 14,
          border: `1px dashed ${accent}88`,
          color: accent,
        }}
      >
        💰 {str(block.message)}
      </div>
    );
  }
  if (type === "links") {
    const items = Array.isArray(block.items) ? block.items : [];
    return (
      <div style={{ margin: "12px 16px 0", display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
        {items.map((it, i) => {
          const item = it as Record<string, unknown>;
          return (
            <span
              key={i}
              style={{ borderRadius: 9999, padding: "4px 12px", fontSize: 12, background: `${accent}1f`, color: accent }}
            >
              🔗 {str(item.label)}
            </span>
          );
        })}
      </div>
    );
  }
  if (type === "gallery") {
    const images = Array.isArray(block.images) ? block.images : [];
    return (
      <div style={{ marginTop: 12, display: "flex", justifyContent: "center", gap: 12, padding: "0 16px", fontSize: 24 }}>
        {images.map((img, i) => (
          <span key={i}>{str(img)}</span>
        ))}
      </div>
    );
  }
  // Legacy planner shape: {type:"text", content}
  if (str(block.content)) {
    return (
      <div style={{ margin: "12px 16px 0", borderRadius: 8, padding: "12px 16px", fontSize: 14, background: `${accent}14` }}>
        {str(block.content)}
      </div>
    );
  }
  return null;
}

const DEMO_SUGGESTIONS = [
  "Show me a live music blockpage",
  "Build me a blockpage for my cafe",
  "Meet Bacon the dino",
  "Meet Blockpage Buddy",
  "Tour Danny's Vision",
  "Meet Information in Motion",
];

// Split a build-log step so MCP tool names render as highlighted chips.
const TOOL_RE =
  /\b(lookup_blockpage|list_templates|blockpage_earnings|list_tip_assets|check_profile_pin|propose_page_update)\b/g;
function stepParts(s: string): Array<{ text: string; tool: boolean }> {
  const out: Array<{ text: string; tool: boolean }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOOL_RE.lastIndex = 0;
  while ((m = TOOL_RE.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), tool: false });
    out.push({ text: m[1], tool: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), tool: false });
  return out;
}

// Every language the Voicescape dapp ships (lib/i18n/dictionaries.ts).
const VOICE_LANGS = [
  { code: "en", label: "English", bcp47: "en-US" },
  { code: "es", label: "Español", bcp47: "es-ES" },
  { code: "zh", label: "中文", bcp47: "zh-CN" },
  { code: "ja", label: "日本語", bcp47: "ja-JP" },
  { code: "ko", label: "한국어", bcp47: "ko-KR" },
  { code: "vi", label: "Tiếng Việt", bcp47: "vi-VN" },
  { code: "id", label: "Bahasa Indonesia", bcp47: "id-ID" },
  { code: "th", label: "ไทย", bcp47: "th-TH" },
  { code: "tl", label: "Tagalog", bcp47: "fil-PH" },
  { code: "tr", label: "Türkçe", bcp47: "tr-TR" },
  { code: "hi", label: "हिन्दी", bcp47: "hi-IN" },
  { code: "ar", label: "العربية", bcp47: "ar-SA" },
  { code: "pt", label: "Português", bcp47: "pt-BR" },
  { code: "fr", label: "Français", bcp47: "fr-FR" },
  { code: "de", label: "Deutsch", bcp47: "de-DE" },
  { code: "it", label: "Italiano", bcp47: "it-IT" },
  { code: "sv", label: "Svenska", bcp47: "sv-SE" },
  { code: "lt", label: "Lietuvių", bcp47: "lt-LT" },
  { code: "ro", label: "Română", bcp47: "ro-RO" },
  { code: "ms", label: "Bahasa Melayu", bcp47: "ms-MY" },
];

/**
 * The founder intro — Alexa's opening "1shot": who built this, the 1-hub
 * vision, and the invitation to try it. Brandon's words, ~45 seconds spoken.
 */
const FOUNDER_INTRO =
  "Welcome to the Voicescape Voice Builder. " +
  "This was built by Brandon Prout — one person, no laptop — " +
  "who took Hedera's vision literally: anyone can carve out their own piece of cyberspace. " +
  "With just their voice, Voicescape is one hub for humans and AI agents, " +
  "for your social media profiles, your business or projects, " +
  "for content creators or just community members, " +
  "this is your one community hub, a blockpage that you actually own, " +
  "and tips you receive instantly, no delays or middleman. " +
  "Tap the mic, and speak your blockpage into existence. Go ahead — try it yourself.";

// The intro, line by line — streams into the terminal while Alexa speaks it.
const INTRO_LINES = [
  "Alexa — show me the money.",
  "Every other platform takes twenty percent off the top, then locks up your money for weeks or months.",
  "Voicescape flips it: a smart contract on the Hedera blockchain splits every payment automatically — ninety-eight percent straight to the creator, two percent keeps the lights on.",
  "No human touches your money. No hidden fees. No lock-up delays. The code enforces it in seconds — not trust, not promises.",
  "When businesses stop bleeding fees and delays, they lower their own prices — so customers save money too.",
  "One hub for humans and AI agents — voice is the newest door in.",
  "Meet our Voicescape dapp community below — or use the microphone and build your blockpage today.",
];

// Inlined as data URIs so the brand marks always render — Vercel's preview
// protection can intermittently 404 subresource requests before the bypass
// cookie lands, which showed as broken-image icons in QA.
const VS_LOGO_DATA = "data:image/webp;base64,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";
const HEDERA_LOGO_DATA = "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4KPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGZpbGw9Im5vbmUiIGhlaWdodD0iMjQiIG92ZXJmbG93PSJ2aXNpYmxlIiBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSJub25lIiBzdHlsZT0iZGlzcGxheTogYmxvY2s7IiB2aWV3Qm94PSIwIDAgODYgMjQiIHdpZHRoPSI4NiI+CjxnIGlkPSJoZWRlcmEtbG9nbyI+CjxnIGlkPSJIZWRlcmEgbG9nbyI+CjxwYXRoIGQ9Ik0zNi43ODUxIDExLjMwNDNIMzAuNDUwNVY2LjcxNDM5SDI4Ljg0NjVWMTcuNDkyOEgzMC40NTA1VjEyLjgxMjJIMzYuNzg1MVYxNy40OTI4SDM4LjM4OVY2LjcxNDM5SDM2Ljc4NTFWMTEuMzA0M1oiIGZpbGw9InZhcigtLWZpbGwtMCwgd2hpdGUpIi8+CjxwYXRoIGQ9Ik00My45NDMxIDExLjA5MjhDNDQuOTkzOCAxMS4wOTI4IDQ1LjczMTkgMTEuNjM2IDQ2LjA4MTcgMTIuNjY2Mkg0MS43Nzk1QzQyLjA4MjcgMTEuNjY0NyA0Mi44Njk2IDExLjA5MjggNDMuOTUxIDExLjA5MjhNNDMuOTUxNyA5Ljc2NDAzQzQxLjc3NTkgOS43NjQwMyA0MC4xMzMzIDExLjQ2NDcgNDAuMTMzMyAxMy43MTY1QzQwLjA4OTYgMTUuODU2OCA0MS43ODMxIDE3LjYyODEgNDMuOTE1MiAxNy42NzEyQzQzLjk3MjUgMTcuNjcyNyA0NC4wMjk4IDE3LjY3MTkgNDQuMDg3MiAxNy42NzEyQzQ2LjY3NjUgMTcuNjcxMiA0Ny41ODI0IDE1LjkyNzMgNDcuNjk3IDE1LjMxNjVMNDcuNzEzNSAxNS4yMjIzSDQ2LjIyNjRMNDYuMjA0MiAxNS4yNjc2QzQ2LjE4NTYgMTUuMzA2NSA0NS42OTYxIDE2LjI1NDcgNDQuMDg3OSAxNi4yNTQ3QzQyLjc2NDIgMTYuMjU0NyA0MS43ODA5IDE1LjMxNjUgNDEuNjcwNiAxMy45NjRINDcuNzc1OVYxMy44ODJDNDcuNzc1OSAxMS40NTc2IDQ2LjE5ODUgOS43NjkwNiA0My45NDEgOS43NjkwNiIgZmlsbD0idmFyKC0tZmlsbC0wLCB3aGl0ZSkiLz4KPHBhdGggZD0iTTUyLjkyMDEgMTYuMjU0N0M1MS41MDQ3IDE2LjI1NDcgNTAuNTE1IDE1LjIxMDEgNTAuNTE1IDEzLjcxODdDNTAuNTE1IDEyLjIyNzMgNTEuNTA0NyAxMS4xODEzIDUyLjkyMDEgMTEuMTgxM0M1NC4zMzU1IDExLjE4MTMgNTUuMjk4NyAxMi4yMjM3IDU1LjI5ODcgMTMuNzE4N0M1NS4yOTg3IDE1LjIxMzcgNTQuMzIxMiAxNi4yNTQ3IDUyLjkyMDEgMTYuMjU0N1pNNTUuMjY3OSAxMC45NjMzQzU0Ljg5NzQgMTAuNDQ4OSA1NC4wNTEgOS43NjQwMyA1Mi42Njc4IDkuNzY0MDNDNTAuNDc5OSA5Ljc2NDAzIDQ4Ljk1MzQgMTEuMzkwNiA0OC45NTM0IDEzLjcxODdDNDguOTUzNCAxNi4wNDY4IDUwLjQ3OTkgMTcuNjcxMiA1Mi42Njc4IDE3LjY3MTJDNTMuNjg2OSAxNy43MDIyIDU0LjY1NzMgMTcuMjMyNCA1NS4yNjc5IDE2LjQxMjlWMTcuNDkyOEg1Ni43ODM2VjYuMzI1OUg1NS4yNjc5VjEwLjk2MzNaIiBmaWxsPSJ2YXIoLS1maWxsLTAsIHdoaXRlKSIvPgo8cGF0aCBkPSJNNjIuMzk1MiAxMS4wOTI4QzYzLjQ0NDQgMTEuMDkyOCA2NC4xODQgMTEuNjM2IDY0LjUzMjMgMTIuNjY2Mkg2MC4yMzAxQzYwLjUzMzMgMTEuNjY0NyA2MS4zMjAyIDExLjA5MjggNjIuNDAzOCAxMS4wOTI4TTYyLjQwMzggOS43NjQwM0M2MC4yMjU4IDkuNzY0MDMgNTguNTgzMiAxMS40NjQ3IDU4LjU4MzIgMTMuNzE2NUM1OC41Mzk1IDE1Ljg1NjggNjAuMjMzIDE3LjYyODEgNjIuMzY1MSAxNy42NzEyQzYyLjQyMjQgMTcuNjcyNyA2Mi40Nzk3IDE3LjY3MTkgNjIuNTM3MSAxNy42NzEyQzY1LjEyNjQgMTcuNjcxMiA2Ni4wMzIyIDE1LjkyNzMgNjYuMTQ2OSAxNS4zMTY1TDY2LjE2MzQgMTUuMjIyM0g2NC42NzYzTDY0LjY1NTUgMTUuMjY3NkM2NC42MzQ3IDE1LjMwNjUgNjQuMTQzMSAxNi4yNTQ3IDYyLjUzNzEgMTYuMjU0N0M2MS4yMTM0IDE2LjI1NDcgNjAuMjMyMyAxNS4zMTY1IDYwLjEyMTkgMTMuOTY0SDY2LjIzNzJWMTMuODgyQzY2LjIzNzIgMTEuNDU3NiA2NC42NTk4IDkuNzY5MDYgNjIuNDA0NSA5Ljc2OTA2IiBmaWxsPSJ2YXIoLS1maWxsLTAsIHdoaXRlKSIvPgo8cGF0aCBkPSJNNjkuNDYxNSAxMS4wNDFWOS45NDMxNkg2Ny45NDM2VjE3LjQ5MDZINjkuNDYxNVYxMy4yMzk2QzY5LjQ2MTUgMTEuOTE5NCA3MC4xNDgxIDExLjQwNSA3MS45MTk3IDExLjQwNUg3My44NzgzVjkuODgzNDVINzEuOTUwNUM3MC40NDkxIDkuODgzNDUgNjkuNzY2OCAxMC41NTE4IDY5LjQ2OTQgMTEuMDQxIiBmaWxsPSJ2YXIoLS1maWxsLTAsIHdoaXRlKSIvPgo8cGF0aCBkPSJNODAuNjE0MiAxMy43MTczQzgwLjYxNDIgMTUuMTg3OCA3OS42NDUzIDE2LjI1NDcgNzguMzExNiAxNi4yNTQ3Qzc2Ljk3NzkgMTYuMjU0NyA3NS45NDk0IDE1LjIxMjIgNzUuOTQ5NCAxMy43MTczQzc1Ljk0OTQgMTIuMjIyMyA3Ni45MjcgMTEuMTgxMyA3OC4zMTggMTEuMTgxM0M3OS43MDkxIDExLjE4MTMgODAuNjIwNyAxMi4yNDg5IDgwLjYyMDcgMTMuNzE3M004MC41ODkxIDEwLjk2NzZDODAuMjkyNCAxMC41NTYxIDc5LjUzNjQgOS43NjQ3NSA3OC4wNjI5IDkuNzY0NzVDNzYuMjM5NyA5Ljc2NDc1IDc0LjM5MzYgMTEuMTIyMyA3NC4zOTM2IDEzLjcxNzNDNzQuMzkzNiAxNi4wNDUzIDc1LjkwMTQgMTcuNjcxOSA3OC4wNjI5IDE3LjY3MTlDNzkuMDU5OCAxNy43MTE1IDgwLjAxMDEgMTcuMjQzOSA4MC41ODkxIDE2LjQyODFWMTcuNDk5M0g4Mi4xMDQ5VjkuOTQzODlIODAuNTg5MVYxMC45Njc2WiIgZmlsbD0idmFyKC0tZmlsbC0wLCB3aGl0ZSkiLz4KPHBhdGggZD0iTTgzLjU3NDEgMTAuMTY3Nkg4My45OTA1VjExLjExMTVIODQuMTQ2VjEwLjE2NzZIODQuNTYxNlYxMC4wMjNIODMuNTc0MVYxMC4xNjc2WiIgZmlsbD0idmFyKC0tZmlsbC0wLCB3aGl0ZSkiLz4KPHBhdGggZD0iTTg1Ljc2MDYgMTAuMDIzTDg1LjQwMTYgMTAuODgyN0w4NS4wNDMzIDEwLjAyM0g4NC43OTk2VjExLjExMTVIODQuOTQ3MlYxMC4xNjc2TDg1LjM0NDIgMTEuMTE3M0g4NS40NTFMODUuODQ0NSAxMC4xNzU1VjExLjExMTVIODZWMTAuMDIzSDg1Ljc2MDZaIiBmaWxsPSJ2YXIoLS1maWxsLTAsIHdoaXRlKSIvPgo8cGF0aCBkPSJNMTUuMzE4IDExLjEzNzRIOC41OTE0VjEyLjg2MTlIMTUuMzE4VjExLjEzNzRaIiBmaWxsPSJ2YXIoLS1maWxsLTAsIHdoaXRlKSIvPgo8cGF0aCBkPSJNMTEuOTU0IDBDNS4zNTIwNyAwIDAgNS4zNzI2NiAwIDEyQzAgMTguNjI3MyA1LjM1MjA3IDI0IDExLjk1NCAyNEMxOC41NTU5IDI0IDIzLjkwOCAxOC42MjczIDIzLjkwOCAxMkMyMy45MDggNS4zNzI2NiAxOC41NTU5IDAgMTEuOTU0IDBaTTE2Ljg5MjUgMTcuMzg5MkgxNS4zMThWMTQuMDEyMkg4LjU5MTRMOC41ODk5NyAxNC4wMDk0VjE3LjM4OTJINy4wMTU0NVY2LjYxMDc5SDguNTg5OTdWOS45ODk5M0w4LjU5MTQgOS45ODg0OUgxNS4zMThWNi42MTE1MUgxNi44OTI1VjE3LjM4OTJaIiBmaWxsPSJ2YXIoLS1maWxsLTAsIHdoaXRlKSIvPgo8L2c+CjwvZz4KPC9zdmc+";

export default function AlexaDemoPage() {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentResponse | null>(null);
  const [visibleSteps, setVisibleSteps] = useState(0);
  const [visibleBlocks, setVisibleBlocks] = useState(0);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [lang, setLang] = useState("en");
  const [showTools, setShowTools] = useState(false);
  // Live Hedera block number for the tools modal — fetched when it opens.
  const [blockNum, setBlockNum] = useState<string | null>(null);
  useEffect(() => {
    if (!showTools || blockNum) return;
    (async () => {
      try {
        const r = await fetch("https://mainnet.mirrornode.hedera.com/api/v1/blocks?limit=1&order=desc");
        const j = await r.json();
        const n = j?.blocks?.[0]?.number;
        if (n != null) setBlockNum(Number(n).toLocaleString("en-US"));
      } catch {
        /* the guide reads fine without the number */
      }
    })();
  }, [showTools, blockNum]);
  const [shareNote, setShareNote] = useState<string | null>(null);

  // Share the demo via the native sheet (mobile) or clipboard fallback.
  // Shares the user's own current URL — never published anywhere by us.
  const shareDemo = useCallback(async () => {
    const url = window.location.href;
    const text = "I spoke a blockpage into existence with Voicescape Voice Builder — voice in, living page out, on Hedera.";
    try {
      if (navigator.share) {
        await navigator.share({ title: "Voicescape Voice Builder", text, url });
        return;
      }
      throw new Error("no native share");
    } catch {
      try {
        await navigator.clipboard.writeText(`${text} ${url}`);
        setShareNote("Demo link copied — paste it anywhere ✓");
      } catch {
        setShareNote("Copy the address bar URL to share");
      }
      window.setTimeout(() => setShareNote(null), 4000);
    }
  }, []);

  const langEntry = VOICE_LANGS.find((l) => l.code === lang) ?? VOICE_LANGS[0];
  const recogRef = useRef<SpeechRecognitionLike | null>(null);

  // iOS: SpeechRecognition exists but is unreliable (buggy on iOS 17+), and
  // iOS Chrome/Firefox don't have it at all (WebKit limitation). Detect once
  // so we can set honest expectations — the type box + keyboard dictation
  // mic is the first-class path there, and speech-out still works fine.
  const [isIOS] = useState(
    () =>
      typeof navigator !== "undefined" &&
      (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1))
  );

  // The founder intro — the user taps, the terminal comes alive with the
  // narration line by line while Alexa speaks it, then hands them the mic.
  // The tap is the gesture TTS needs.
  const introTimers = useRef<number[]>([]);
  const [introActive, setIntroActive] = useState(false);
  const [introLines, setIntroLines] = useState<string[]>([]);
  const cancelIntro = useCallback(() => {
    introTimers.current.forEach((t) => window.clearTimeout(t));
    introTimers.current = [];
    setIntroActive(false);
    setIntroLines([]);
  }, []);

  useEffect(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) setSupported(false);
    return () => {
      recogRef.current?.abort();
      window.speechSynthesis?.cancel();
      cancelIntro();
    };
  }, [cancelIntro]);

  const speak = useCallback((text: string, bcp47: string, code: string) => {    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = bcp47;
    u.rate = 1.02;
    // Prefer a voice matching the selected language when available.
    const voices = window.speechSynthesis.getVoices();
    const match =
      voices.find((v) => v.lang.toLowerCase().startsWith(code.toLowerCase())) ??
      voices.find((v) => v.lang.toLowerCase().startsWith(bcp47.split("-")[0].toLowerCase()));
    if (match) u.voice = match;
    window.speechSynthesis.speak(u);
  }, []);

  // (playIntro lives below, next to speak — it needs the TTS voice first)
  const playIntro = useCallback(() => {
    cancelIntro();
    window.speechSynthesis?.cancel();
    setIntroActive(true);
    setIntroLines([]);
    speak(FOUNDER_INTRO, "en-US", "en");
    INTRO_LINES.forEach((line, i) => {
      introTimers.current.push(
        window.setTimeout(() => setIntroLines((prev) => [...prev, line]), 1200 + i * 3500)
      );
    });
    // The handoff — lands as she finishes speaking.
    introTimers.current.push(
      window.setTimeout(
        () => setIntroLines((prev) => [...prev, "$ tap the mic — speak your blockpage into existence 🎤"]),
        1200 + INTRO_LINES.length * 3500
      )
    );
  }, [cancelIntro, speak]);

  const runAgent = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || busy) return;
      cancelIntro();
      window.speechSynthesis?.cancel();
      setBusy(true);
      setError(null);
      setAgent(null);
      setVisibleSteps(0);
      setVisibleBlocks(0);
      const bcp47 = langEntry.bcp47;
      const code = langEntry.code;
      try {
        const res = await fetch("/api/alexa-demo/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: prompt,
            lang: code,
            // Send the page on screen so the agent can EDIT it
            // ("change the title to X") instead of rebuilding.
            currentDraft: agent
              ? {
                  displayName: agent.pageDraft.displayName,
                  theme: agent.pageDraft.theme,
                  blocks: agent.pageDraft.blocks,
                }
              : null,
          }),
        });
        const data = (await res.json()) as AgentResponse;
        if (!res.ok) throw new Error(data.error ?? "agent failed");
        setAgent(data);
        if (autoSpeak && data.speak) speak(data.speak, bcp47, code);
      } catch (e) {
        setError(e instanceof Error ? e.message : "something went wrong");
      } finally {
        setBusy(false);
      }
    },
    [busy, autoSpeak, speak, langEntry, agent, cancelIntro]
  );

  // Stagger the build-log steps so the page visibly "builds itself".
  useEffect(() => {
    if (!agent || visibleSteps >= agent.steps.length) return;
    const t = setTimeout(() => setVisibleSteps((v) => v + 1), 650);
    return () => clearTimeout(t);
  }, [agent, visibleSteps]);

  const startListening = useCallback(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) {
      setSupported(false);
      return;
    }
    window.speechSynthesis?.cancel();
    cancelIntro();
    const recog = new SR();
    recog.lang = langEntry.bcp47;
    recog.interimResults = true;
    recog.maxAlternatives = 1;
    let finalText = "";
    recog.onresult = (e) => {
      const last = e.results[e.results.length - 1]?.[0];
      if (last) {
        finalText = last.transcript;
        setTranscript(finalText);
      }
    };
    recog.onerror = (e) => {
      const code = e.error || "unknown";
      setListening(false);
      if (code === "not-allowed" || code === "service-not-allowed") {
        setError("Mic blocked — allow microphone access or type your prompt.");
      } else if (code === "audio-capture") {
        setError(
          "The mic is busy — if you're screen recording with microphone audio, " +
            "switch the recorder to internal audio only, or type your prompt instead."
        );
      } else if (code !== "no-speech" && code !== "aborted") {
        setError("Didn't catch that — try again or type it.");
      }
    };
    recog.onend = () => {
      setListening(false);
      recogRef.current = null;
      if (finalText.trim()) runAgent(finalText);
    };
    recogRef.current = recog;
    setTranscript("");
    setError(null);
    setListening(true);
    try {
      recog.start();
    } catch (e) {
      setListening(false);
      recogRef.current = null;
      setError("Mic couldn't start — type your prompt below instead.");
    }
  }, [runAgent, langEntry, cancelIntro]);

  const theme = agent?.pageDraft.theme ?? {};
  const bg = theme.background ?? "#0f172a";
  const fg = theme.foreground ?? "#f1f5f9";
  const accent = theme.accent ?? "#38bdf8";
  const fontFamily = theme.fontFamily ?? "inherit";
  const blocks = (agent?.pageDraft.blocks ?? []) as Array<Record<string, unknown>>;
  const hasTipJar = blocks.some((b) => b.type === "tipJar");
  const hasHero = blocks.some((b) => b.type === "hero");
  const previewReady = !!agent && visibleSteps >= agent.steps.length;
  const blocksDone = visibleBlocks >= blocks.length;

  // The signature moment: once the plan is done, the page materializes
  // block by block — hero, music, livestream, tip jar — like it's being
  // spoken into existence. (Deps must include visibleBlocks itself, or the
  // cascade stalls after the first block — fixed 2026-10-10.)
  useEffect(() => {
    if (!previewReady || visibleBlocks >= blocks.length) return;
    const t = setTimeout(() => setVisibleBlocks((v) => v + 1), 850);
    return () => clearTimeout(t);
  }, [previewReady, visibleBlocks, blocks.length]);

  return (
    <main
      style={{ position: "relative", minHeight: "100vh", overflow: "hidden", padding: "40px 16px", color: "#e2e8f0", background: "#020617" }}
    >
      {/* Ambient animated background */}
      <div aria-hidden className="alexa-ambient" />
      <style>{`
        .alexa-ambient {
          position: absolute; inset: 0; pointer-events: none;
          background:
            radial-gradient(600px 400px at 20% 10%, rgba(56,189,248,.10), transparent 60%),
            radial-gradient(700px 500px at 85% 80%, rgba(168,85,247,.10), transparent 60%),
            radial-gradient(500px 400px at 60% 30%, rgba(52,211,153,.06), transparent 60%);
          animation: ambient-drift 14s ease-in-out infinite alternate;
        }
        @keyframes ambient-drift {
          from { transform: translate3d(-2%, -1%, 0) scale(1); }
          to   { transform: translate3d(2%, 2%, 0) scale(1.06); }
        }
        .mic-ring { position: absolute; inset: 0; border-radius: 9999px; pointer-events: none; }
        .mic-ring.r1 { animation: ring-expand 2s ease-out infinite; border: 2px solid rgba(56,189,248,.55); }
        .mic-ring.r2 { animation: ring-expand 2s ease-out .65s infinite; border: 2px solid rgba(56,189,248,.35); }
        .mic-ring.r3 { animation: ring-expand 2s ease-out 1.3s infinite; border: 2px solid rgba(56,189,248,.2); }
        @keyframes ring-expand {
          from { transform: scale(1); opacity: 1; }
          to   { transform: scale(1.9); opacity: 0; }
        }
        .waveform { display: flex; align-items: flex-end; gap: 3px; height: 28px; }
        .waveform span {
          width: 4px; border-radius: 2px; background: #38bdf8;
          animation: wave-bounce 0.9s ease-in-out infinite;
        }
        .waveform span:nth-child(1) { animation-delay: 0s; }
        .waveform span:nth-child(2) { animation-delay: .12s; }
        .waveform span:nth-child(3) { animation-delay: .24s; }
        .waveform span:nth-child(4) { animation-delay: .36s; }
        .waveform span:nth-child(5) { animation-delay: .48s; }
        .waveform span:nth-child(6) { animation-delay: .36s; }
        .waveform span:nth-child(7) { animation-delay: .24s; }
        @keyframes wave-bounce {
          0%, 100% { height: 6px; opacity: .5; }
          50% { height: 26px; opacity: 1; }
        }
        .step-in { animation: step-in .45s cubic-bezier(.2,.9,.3,1.2) both; }
        @keyframes step-in {
          from { opacity: 0; transform: translateX(-14px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        .preview-in { animation: preview-in .8s cubic-bezier(.16,1,.3,1) both; }
        @keyframes preview-in {
          from { opacity: 0; transform: translateY(28px) scale(.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .live-dot { animation: live-pulse 1.6s ease-in-out infinite; }
        @keyframes live-pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(52,211,153,.5); }
          50% { opacity: .65; box-shadow: 0 0 0 6px rgba(52,211,153,0); }
        }
        .glow-btn { transition: transform .15s ease, box-shadow .25s ease; }
        .glow-btn:not(:disabled):hover { transform: scale(1.05); }
        .glow-btn:not(:disabled):active { transform: scale(.94); }
        .cursor-blink { animation: cursor-blink 1s steps(1) infinite; }
        @keyframes cursor-blink {
          0%, 55% { opacity: 1; }
          56%, 100% { opacity: 0; }
        }
        /* Voicescape agent equalizer — the agent's living pulse */
        .agent-eq { display: flex; align-items: flex-end; gap: 2px; height: 14px; }
        .agent-eq span {
          width: 3px; border-radius: 2px; background: #38bdf8;
          animation: eq-bounce 0.8s ease-in-out infinite;
        }
        .agent-eq span:nth-child(2) { animation-delay: .15s; background: #a78bfa; }
        .agent-eq span:nth-child(3) { animation-delay: .3s; background: #34d399; }
        @keyframes eq-bounce {
          0%, 100% { height: 4px; opacity: .6; }
          50% { height: 14px; opacity: 1; }
        }
        /* Puzzle-piece snap: each block flies in from alternating sides,
           overshoots, flashes, and clicks into place. Slow and legible —
           you can SEE the chain being built. */
        .block-lands { animation: block-snap .7s cubic-bezier(.2,.9,.25,1.15) both; will-change: transform, opacity, filter; }
        @keyframes block-snap {
          0% {
            opacity: 0;
            transform: translate(var(--enter-x, -56px), 22px) rotate(-2deg) scale(.94);
            filter: brightness(1.8);
          }
          50% {
            opacity: 1;
            transform: translate(0, 0) rotate(.6deg) scale(1.02);
            filter: brightness(1.15);
          }
          72% {
            transform: translate(0, 0) rotate(-.2deg) scale(1);
            filter: brightness(1);
          }
          100% {
            opacity: 1;
            transform: translate(0, 0) rotate(0) scale(1);
            filter: brightness(1);
          }
        }
        /* Incoming piece slot — pulses where the next piece will land */
        .incoming-slot {
          margin: 12px 16px 0;
          height: 64px;
          border-radius: 12px;
          border: 1.5px dashed rgba(125,211,252,.4);
          background: rgba(56,189,248,.04);
          animation: slot-pulse 1.1s ease-in-out infinite;
        }
        @keyframes slot-pulse {
          0%, 100% { opacity: .35; transform: scale(.995); }
          50% { opacity: .9; transform: scale(1); }
        }
        /* Celebration finale */
        .celebrate { animation: celebrate-pop .8s cubic-bezier(.2,.9,.3,1.4) both; }
        @keyframes celebrate-pop {
          0% { opacity: 0; transform: scale(.6); filter: brightness(2); }
          60% { opacity: 1; transform: scale(1.12); filter: brightness(1.3); }
          100% { opacity: 1; transform: scale(1); filter: brightness(1); }
        }
        /* Waking dots */
        .waking-dots span { animation: waking-blink 1.2s ease-in-out infinite; display: inline-block; }
        .waking-dots span:nth-child(2) { animation-delay: .2s; }
        .waking-dots span:nth-child(3) { animation-delay: .4s; }
        @keyframes waking-blink {
          0%, 100% { opacity: .25; }
          50% { opacity: 1; }
        }
        /* Amazon kicker — same size, same place, impossible to miss */
        .amazon-pulse { animation: amazon-glow 2.4s ease-in-out infinite; }
        @keyframes amazon-glow {
          0%, 100% { opacity: 1; text-shadow: 0 0 10px rgba(56,189,248,.55); }
          50% { opacity: .8; text-shadow: 0 0 26px rgba(56,189,248,.95); }
        }
      `}</style>
      <div style={{ position: "relative", margin: "0 auto", maxWidth: 768 }}>
        {/* Voicescape brand mark */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 14, marginTop: 4 }}>
          <img
            src={VS_LOGO_DATA}
            alt="Voicescape"
            style={{ height: 52, width: "auto", display: "block" }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <p className="amazon-pulse" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.2em", color: "#38bdf8", margin: 0 }}>
            Amazon hackathon · Alexa+ track
          </p>
          <button
            onClick={() => setShowTools(true)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              borderRadius: 9999,
              border: "1px solid rgba(52,211,153,.3)",
              background: "rgba(52,211,153,.1)",
              padding: "4px 12px",
              fontSize: 11,
              fontWeight: 600,
              color: "#6ee7b7",
              whiteSpace: "nowrap",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <span className="live-dot" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 9999, background: "#34d399" }} />
            LIVE MCP · 64 tools
          </button>
        </div>
        <h1
          style={{
            marginTop: 8,
            marginBottom: 0,
            fontSize: "2rem",
            lineHeight: 1.15,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            background: "linear-gradient(90deg, #7dd3fc, #a5f3fc, #c4b5fd)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          Speak your blockpage into existence.
        </h1>
        <p style={{ marginTop: 8, maxWidth: 576, color: "#94a3b8", fontSize: 14, lineHeight: 1.5 }}>
          Tap the mic — the agent plans over Voicescape&apos;s live MCP server
          and your blockpage comes alive below.
        </p>
        {/* Identity strip — real open-source rails, each badge links out */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          {[
            ["Alexa+ track", "simulated experience", "https://amazonappdev2026.devpost.com/"],
            ["Hedera mainnet", "live", "https://hedera.com"],
            ["Hedera Agent Kit", "v4", "https://github.com/hedera-dev/hedera-agent-kit"],
            ["MCP", "spec 2025-11-25", "https://modelcontextprotocol.io/specification/2025-11-25"],
          ].map(([name, sub, href]) => (
            <a
              key={name}
              href={href}
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "baseline",
                gap: 6,
                borderRadius: 9999,
                border: "1px solid rgba(148,163,184,.25)",
                background: "rgba(148,163,184,.07)",
                padding: "4px 11px",
                fontSize: 11,
                color: "#cbd5e1",
                textDecoration: "none",
              }}
            >
              <strong style={{ fontWeight: 700, color: "#f1f5f9" }}>{name}</strong>
              <span style={{ color: "#94a3b8" }}>{sub}</span>
            </a>
          ))}
        </div>
        <p style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
          Works today on any device with a browser and a mic — phone, PC,
          tablet. Voice builds it, you claim it on the dapp.
        </p>
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#94a3b8" }}>
          <span aria-hidden>🌐</span>
          <label htmlFor="voice-lang" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.15em", color: "#64748b" }}>
            Voice language
          </label>
          <select
            id="voice-lang"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            style={{
              borderRadius: 8,
              border: "1px solid #334155",
              background: "#0f172a",
              padding: "6px 12px",
              minHeight: 44,
              fontSize: 14,
              color: "#f1f5f9",
            }}
          >
            {VOICE_LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>

        {/* Voice button */}
        <div style={{ marginTop: 24, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <div style={{ position: "relative" }}>
            {listening && (
              <>
                <span className="mic-ring r1" />
                <span className="mic-ring r2" />
                <span className="mic-ring r3" />
              </>
            )}
            <button
              onClick={listening ? () => recogRef.current?.stop() : startListening}
              disabled={busy}
              aria-label={listening ? "Stop listening" : "Start voice prompt"}
              className="glow-btn"
              style={{
                // Inline sizing: bulletproof even if the Tailwind bundle is stale.
                width: 104,
                height: 104,
                minWidth: 104,
                minHeight: 104,
                borderRadius: 9999,
                fontSize: 42,
                lineHeight: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
                border: "none",
                cursor: busy ? "default" : "pointer",
                color: "#020617",
                opacity: busy ? 0.5 : 1,
                backgroundColor: listening ? "#ef4444" : "#38bdf8",
                backgroundImage: listening
                  ? "radial-gradient(circle at 35% 30%, #fca5a5, #ef4444)"
                  : "radial-gradient(circle at 35% 30%, #a5f3fc, #38bdf8 70%)",
                boxShadow: listening
                  ? "0 0 50px rgba(239,68,68,.45)"
                  : "0 0 50px rgba(56,189,248,.35)",
              }}
            >
              {listening ? "⏹" : "🎙"}
            </button>
          </div>
          {listening ? (
            <div className="waveform" aria-hidden>
              <span /><span /><span /><span /><span /><span /><span />
            </div>
          ) : (
            <p style={{ fontSize: 14, color: "#94a3b8", margin: 0 }}>
              {busy ? "Agent is building…" : "Tap and speak"}
            </p>
          )}
          {!supported && (
            <p style={{ fontSize: 14, color: "#fcd34d", margin: 0 }}>
              Voice input isn&apos;t supported in this browser — type below.
            </p>
          )}
          {supported && isIOS && (
            <p style={{ fontSize: 12, color: "#64748b", margin: 0, maxWidth: 440, textAlign: "center", lineHeight: 1.5 }}>
              iPhone tip: the browser mic can be flaky on iOS — you can also
              dictate with the <strong style={{ color: "#94a3b8" }}>mic key on your keyboard</strong>,
              or just type. The agent talks back out loud either way. 🎙
            </p>
          )}
          {/* Founder intro — right by the mic, where the gesture makes sense.
              The START HERE cue tells newcomers the order: intro first,
              then the mic. Either order works. */}
          {!busy && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: "0.14em",
                  color: "#020617",
                  background: "linear-gradient(90deg, #38bdf8, #a78bfa)",
                  padding: "6px 12px",
                  borderRadius: 9999,
                  whiteSpace: "nowrap",
                }}
              >
                ① START HERE
              </span>
              <button
                onClick={playIntro}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  minHeight: 44,
                  gap: 8,
                  borderRadius: 9999,
                  border: "1px solid rgba(125,211,252,.3)",
                  background: "rgba(125,211,252,.06)",
                  padding: "10px 18px",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#7dd3fc",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <span aria-hidden>▶</span> {introActive ? "Replay the pitch" : "The 20-second pitch — 1-hub vision"}
              </button>
            </div>
          )}
          {transcript && (
            <p className="preview-in" style={{ textAlign: "center", fontSize: 20, color: "#f1f5f9", margin: 0 }}>“{transcript}”</p>
          )}

          {/* Type fallback */}
          <form
            style={{ display: "flex", width: "100%", maxWidth: 576, gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              runAgent(typed);
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Or type your prompt…"
              style={{
                flex: 1,
                borderRadius: 12,
                border: "1px solid rgba(51,65,85,.8)",
                background: "rgba(15,23,42,.8)",
                padding: "10px 16px",
                minHeight: 44,
                fontSize: 16,
                color: "#f1f5f9",
              }}
            />
            <button
              type="submit"
              disabled={busy}
              className="glow-btn"
              style={{
                borderRadius: 12,
                background: "#38bdf8",
                padding: "10px 20px",
                minHeight: 44,
                fontWeight: 600,
                fontSize: 15,
                color: "#020617",
                border: "none",
                cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.5 : 1,
              }}
            >
              Build
            </button>
          </form>

          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
            {DEMO_SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => runAgent(s)}
                disabled={busy}
                className="glow-btn"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  minHeight: 44,
                  borderRadius: 9999,
                  border: "1px solid rgba(51,65,85,.8)",
                  background: "rgba(15,23,42,.6)",
                  padding: "10px 18px",
                  fontSize: 12,
                  color: "#cbd5e1",
                  cursor: busy ? "default" : "pointer",
                  opacity: busy ? 0.5 : 1,
                }}
              >
                ✨ {s}
              </button>
            ))}
          </div>

          <label style={{ display: "flex", cursor: "pointer", alignItems: "center", gap: 8, fontSize: 14, color: "#64748b" }}>
            <input
              type="checkbox"
              checked={autoSpeak}
              onChange={(e) => setAutoSpeak(e.target.checked)}
              style={{ accentColor: "#38bdf8" }}
            />
            Speak the agent&apos;s reply out loud
          </label>
        </div>

        {error && (
          <p style={{
            margin: "24px auto 0",
            maxWidth: 576,
            borderRadius: 12,
            border: "1px solid rgba(127,29,29,.6)",
            background: "rgba(69,10,10,.4)",
            padding: "12px 16px",
            fontSize: 14,
            color: "#fca5a5",
          }}>
            {error}
          </p>
        )}

        {/* Agent terminal — original Voicescape vibe */}
        {/* Waking state: the instant the mic hands off, before the first
            byte is back — no dead gap. */}
        {introActive && !busy && (
          <section style={{ margin: "28px auto 0", maxWidth: 576 }}>
            <div
              style={{
                overflow: "hidden",
                borderRadius: 14,
                border: "1px solid rgba(56,189,248,.18)",
                background: "#05070d",
                boxShadow: "0 0 40px rgba(56,189,248,.06), 0 20px 40px -12px rgba(0,0,0,.7)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 14px",
                  background: "linear-gradient(90deg, rgba(56,189,248,.08), rgba(167,139,250,.08))",
                  borderBottom: "1px solid rgba(30,41,59,.8)",
                }}
              >
                <span className="agent-eq" aria-hidden>
                  <span /><span /><span />
                </span>
                <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.35 }}>
                  <span style={{ fontSize: 10, letterSpacing: "0.22em", fontWeight: 800, color: "#7dd3fc" }}>
                    VOICESCAPE AGENT
                  </span>
                  <span style={{ fontSize: 9, color: "#475569", letterSpacing: "0.04em" }}>
                    founder intro · the 1-hub vision
                  </span>
                </span>
              </div>
              <div style={{ padding: "14px", fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 13, lineHeight: 1.7 }}>
                <div style={{ color: "#7dd3fc" }}>
                  <span style={{ color: "#38bdf8", fontWeight: 700 }}>$</span> the 20-second pitch
                  <span className="waking-dots"><span>.</span><span>.</span><span>.</span></span>
                </div>
                {introLines.map((line, i) => (
                  <div
                    key={i}
                    className="preview-in"
                    style={{ color: line.startsWith("$") ? "#34d399" : "#94a3b8" }}
                  >
                    {line.startsWith("$") ? line : <><span style={{ color: "#475569" }}>❯ </span>{line}</>}
                  </div>
                ))}
                <span style={{ display: "inline-block", width: 8, height: 15, marginTop: 8, background: "#38bdf8", verticalAlign: "-2px", animation: "blink 1s steps(1) infinite" }} />
              </div>
            </div>
          </section>
        )}
        {busy && !agent && (
          <section style={{ margin: "28px auto 0", maxWidth: 576 }}>
            <div
              style={{
                overflow: "hidden",
                borderRadius: 14,
                border: "1px solid rgba(56,189,248,.18)",
                background: "#05070d",
                boxShadow: "0 0 40px rgba(56,189,248,.06), 0 20px 40px -12px rgba(0,0,0,.7)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 14px",
                  background: "linear-gradient(90deg, rgba(56,189,248,.08), rgba(167,139,250,.08))",
                  borderBottom: "1px solid rgba(30,41,59,.8)",
                }}
              >
                <span className="agent-eq" aria-hidden>
                  <span /><span /><span />
                </span>
                <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.35 }}>
                  <span style={{ fontSize: 10, letterSpacing: "0.22em", fontWeight: 800, color: "#7dd3fc" }}>
                    VOICESCAPE AGENT
                  </span>
                  <span style={{ fontSize: 9, color: "#475569", letterSpacing: "0.04em" }}>
                    generative UI · built with Hedera Agent Kit v4
                  </span>
                </span>
              </div>
              <div style={{ padding: "14px", fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 13, color: "#7dd3fc" }}>
                <span style={{ color: "#38bdf8", fontWeight: 700 }}>$</span> waking the agent
                <span className="waking-dots"><span>.</span><span>.</span><span>.</span></span>
                <span style={{ display: "inline-block", width: 8, height: 15, marginLeft: 6, background: "#38bdf8", verticalAlign: "-2px", animation: "blink 1s steps(1) infinite" }} />
              </div>
            </div>
          </section>
        )}
        {agent && (
          <section style={{ margin: "28px auto 0", maxWidth: 576 }}>
            <div
              style={{
                overflow: "hidden",
                borderRadius: 14,
                border: "1px solid rgba(56,189,248,.18)",
                background: "#05070d",
                boxShadow: "0 0 40px rgba(56,189,248,.06), 0 20px 40px -12px rgba(0,0,0,.7)",
              }}
            >
              {/* Custom header — the agent's living pulse */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 14px",
                  background: "linear-gradient(90deg, rgba(56,189,248,.08), rgba(167,139,250,.08))",
                  borderBottom: "1px solid rgba(30,41,59,.8)",
                }}
              >
                <span className="agent-eq" aria-hidden>
                  <span /><span /><span />
                </span>
                <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.35 }}>
                  <span style={{ fontSize: 10, letterSpacing: "0.22em", fontWeight: 800, color: "#7dd3fc" }}>
                    VOICESCAPE AGENT
                  </span>
                  <span style={{ fontSize: 9, color: "#475569", letterSpacing: "0.04em" }}>
                    generative UI · built with Hedera Agent Kit v4
                  </span>
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.15em",
                    color: "#34d399",
                  }}
                >
                  <span className="live-dot" style={{ display: "inline-block", width: 7, height: 7, borderRadius: 9999, background: "#34d399" }} />
                  LIVE
                </span>
              </div>
              {/* Body */}
              <div style={{ padding: 16, fontFamily: "ui-monospace, monospace", fontSize: 13, lineHeight: 1.7 }}>
                {agent.steps.slice(0, visibleSteps).map((s, i) => (
                  <div key={i} className="step-in" style={{ marginBottom: 6 }}>
                    <span style={{ marginRight: 8, color: "#475569", userSelect: "none" }}>$</span>
                    <span style={{ color: "#cbd5e1" }}>
                      {stepParts(s).map((p, j) =>
                        p.tool ? (
                          <code
                            key={j}
                            style={{
                              background: "rgba(52,211,153,.12)",
                              border: "1px solid rgba(52,211,153,.25)",
                              borderRadius: 6,
                              padding: "1px 6px",
                              fontSize: 11,
                              color: "#6ee7b7",
                            }}
                          >
                            {p.text}
                          </code>
                        ) : (
                          <span key={j}>{p.text}</span>
                        )
                      )}
                    </span>
                    <span style={{ marginLeft: 8, color: "#34d399" }}>✓</span>
                  </div>
                ))}
                {(busy || visibleSteps < agent.steps.length) && (
                  <div>
                    <span style={{ marginRight: 8, color: "#475569", userSelect: "none" }}>$</span>
                    <span className="cursor-blink" style={{ color: "#34d399" }}>▊</span>
                  </div>
                )}
                {previewReady && blocksDone && (
                  <>
                    <div className="step-in">
                      <span style={{ marginRight: 8, color: "#475569", userSelect: "none" }}>$</span>
                      <span style={{ color: "#6ee7b7", fontWeight: 600 }}>
                        blockpage materialized ✨
                      </span>
                    </div>
                    {/* Session recap — the terminal stays alive, not idle */}
                    <div className="step-in" style={{ marginTop: 4, fontSize: 11, color: "#64748b" }}>
                      <span style={{ marginRight: 8, color: "#475569", userSelect: "none" }}>$</span>
                      ▣ {blocks.length} piece{blocks.length === 1 ? "" : "s"} · ⚡ {agent.toolResults.length} live tool{agent.toolResults.length === 1 ? "" : "s"} · 🎙 ready for your next command
                    </div>
                  </>
                )}
              </div>
              {/* Status bar */}
              {agent.mcp && visibleSteps >= agent.steps.length && (
                <div
                  style={{
                    borderTop: "1px solid rgba(30,41,59,.8)",
                    padding: "8px 16px",
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "#475569",
                    background: "#0a0d16",
                  }}
                >
                  {agent.mcp.serverName} · MCP {agent.mcp.protocolVersion} · Streamable HTTP · zero mocking
                  {agent.toolResults.length > 0 &&
                    ` · tools: ${agent.toolResults.map((t) => t.tool).join(", ")}`}
                </div>
              )}
            </div>
          </section>
        )}

        {/* Blockpage preview — the star of the screen */}
        <section style={{ margin: "28px auto 0", maxWidth: 768 }}>
          <h2 style={{ marginBottom: 12, textAlign: "center", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.22em", color: "#64748b" }}>
            Your blockpage
          </h2>
          {/* Assembly progress — you can SEE the puzzle coming together */}
          {previewReady && !blocksDone && blocks.length > 0 && (
            <div style={{ marginBottom: 10, textAlign: "center" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#7dd3fc", letterSpacing: "0.08em" }}>
                ▣ assembling piece {Math.min(visibleBlocks + 1, blocks.length)} of {blocks.length}
              </div>
              <div style={{ marginTop: 6, height: 4, borderRadius: 9999, background: "rgba(30,41,59,.9)", overflow: "hidden", maxWidth: 280, marginLeft: "auto", marginRight: "auto" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${(visibleBlocks / blocks.length) * 100}%`,
                    background: "linear-gradient(90deg, #38bdf8, #a78bfa)",
                    borderRadius: 9999,
                    transition: "width .5s ease",
                  }}
                />
              </div>
            </div>
          )}
          {!previewReady || !agent ? (
            /* Empty stage — waiting for voice to wake the dapp */
            <div
              style={{
                borderRadius: 20,
                border: "1.5px dashed rgba(56,189,248,.3)",
                background: "rgba(56,189,248,.03)",
                padding: "48px 24px",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 36, opacity: 0.7 }}>🎙</div>
              <p style={{ marginTop: 12, fontSize: 15, color: "#94a3b8" }}>
                {agent ? "The agent is building…" : "Speak — your blockpage materializes here"}
              </p>
              <p style={{ marginTop: 6, fontSize: 12, color: "#475569" }}>
                Voice in, AI tools, living page out. Nothing typed, nothing mocked.
              </p>
            </div>
          ) : (
            <>
            <div
              className="preview-in"
              style={{
                overflow: "hidden",
                borderRadius: 20,
                border: `1px solid ${accent}55`,
                background: bg,
                color: fg,
                fontFamily,
                boxShadow: `0 0 80px ${accent}22, 0 25px 50px -12px rgba(0,0,0,.6)`,
              }}
            >
              <div style={{ height: 6, background: `linear-gradient(90deg, ${accent}, #a78bfa)` }} />
              {!hasHero && (
                <div style={{ padding: 24 }}>
                  <div
                    style={{
                      margin: "0 auto",
                      display: "flex",
                      width: 64,
                      height: 64,
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 9999,
                      fontSize: 24,
                      fontWeight: 700,
                      background: `${accent}26`,
                      color: accent,
                    }}
                  >
                    {(agent.pageDraft.displayName ?? "?").slice(0, 1).toUpperCase()}
                  </div>
                  <h3 style={{ marginTop: 12, textAlign: "center", fontSize: 20, fontWeight: 700 }}>
                    {agent.pageDraft.displayName ?? "Your page"}
                  </h3>
                  {agent.pageDraft.purpose && (
                    <p style={{ marginTop: 8, textAlign: "center", fontSize: 14, opacity: 0.8 }}>{agent.pageDraft.purpose}</p>
                  )}
                </div>
              )}
              {hasHero && agent.pageDraft.purpose && (
                <p style={{ padding: "16px 24px 0", textAlign: "center", fontSize: 12, opacity: 0.6 }}>{agent.pageDraft.purpose}</p>
              )}
              {blocks.slice(0, visibleBlocks).map((b, i) => (
                <div
                  key={i}
                  className="block-lands"
                  style={{ "--enter-x": i % 2 === 0 ? "-56px" : "56px" } as CSSProperties}
                >
                  <BlockView block={b} accent={accent} />
                </div>
              ))}
              {/* The next piece's slot pulses before it lands */}
              {!blocksDone && <div className="incoming-slot" aria-hidden />}
              {blocksDone && !hasTipJar && (
                <div
                  className="step-in"
                  style={{
                    margin: "16px 16px 0",
                    borderRadius: 8,
                    padding: "12px 16px",
                    textAlign: "center",
                    fontSize: 14,
                    fontWeight: 600,
                    border: `1px dashed ${accent}88`,
                    color: accent,
                  }}
                >
                  Tips open on the live dapp — creators keep 98% of every tip
                </div>
              )}
              {blocksDone && (agent.pageDraft.socials ?? []).length > 0 && (
                <div className="step-in" style={{ marginTop: 16, display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
                  {agent.pageDraft.socials!.map((s, i) => (
                    <span
                      key={i}
                      style={{ borderRadius: 9999, padding: "4px 12px", fontSize: 12, background: `${accent}1f`, color: accent }}
                    >
                      {s.platform}
                    </span>
                  ))}
                </div>
              )}
              {blocksDone && (agent.pageDraft.links ?? []).length > 0 && (
                <ul className="step-in" style={{ marginTop: 16, padding: "0 24px 8px", fontSize: 14, listStyle: "none" }}>
                  {agent.pageDraft.links!.map((l, i) => (
                    <li key={i} style={{ opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      🔗 {l.label}
                    </li>
                  ))}
                </ul>
              )}
              <div style={{ height: 16 }} />
            </div>
            {blocksDone && (
              <p
                className="celebrate"
                style={{
                  marginTop: 16,
                  textAlign: "center",
                  fontSize: 17,
                  fontWeight: 800,
                  background: "linear-gradient(90deg, #7dd3fc, #c4b5fd, #7dd3fc)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                ✨ spoken into existence ✨
              </p>
            )}
            {agent.disclaimer && (
              <p style={{ marginTop: 12, textAlign: "center", fontSize: 12, color: "#64748b" }}>{agent.disclaimer}</p>
            )}
            <div style={{ marginTop: 16, textAlign: "center" }}>
              <a
                href="https://voicescape.vercel.app"
                target="_blank"
                rel="noreferrer"
                className="glow-btn"
                style={{
                  display: "inline-block",
                  borderRadius: 12,
                  background: "#38bdf8",
                  padding: "10px 20px",
                  fontWeight: 600,
                  fontSize: 15,
                  color: "#020617",
                  textDecoration: "none",
                }}
              >
                Make it yours on the live dapp →
              </a>
              <div style={{ marginTop: 10 }}>
                <button
                  onClick={shareDemo}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    borderRadius: 9999,
                    border: "1px solid rgba(167,139,250,.4)",
                    background: "rgba(167,139,250,.08)",
                    padding: "8px 18px",
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#c4b5fd",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  ↗ Share this demo
                </button>
                {shareNote && (
                  <p style={{ marginTop: 6, fontSize: 11, color: "#34d399" }}>{shareNote}</p>
                )}
              </div>
              <p style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
                Claiming happens in your own wallet — the agent previews, you own it.
              </p>
            </div>
            </>
          )}
          </section>

        {/* The bigger picture — the full vision, one shot. Honestly labeled:
            what's live vs. what's next. */}
        <section style={{ margin: "48px auto 0", maxWidth: 768 }}>
          <h2 style={{ marginBottom: 6, textAlign: "center", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.22em", color: "#64748b" }}>
            The bigger picture
          </h2>
          <p style={{ marginTop: 0, marginBottom: 16, textAlign: "center", fontSize: 13, color: "#94a3b8" }}>
            This demo is one door. Here&apos;s the whole house.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
            {[
              {
                icon: "🎙️",
                title: "Voice builds",
                body: "This demo. Speak, the agent works 64 live MCP tools, and your page materializes block by block.",
                status: "live now",
                live: true,
              },
              {
                icon: "🤖",
                title: "One hub, humans + agents",
                body: "For your social profiles, business, or projects — creators and community members alike. One community hub: a blockpage you actually own, tips instantly with no middleman, humans and AI agents side by side. Voice is the newest door in.",
                status: "live now",
                live: true,
              },
              {
                icon: "⚡",
                title: "Real money, tiny fees",
                body: "98% of every tip to the creator, enforced by the smart contract. A $1 tip costs a fraction of a cent on Hedera.",
                status: "live now",
                live: true,
              },
              {
                icon: "📺",
                title: "Any screen",
                body: "Phone today. TV, smart glasses, every smart screen next — voice is the newest door in.",
                status: "vision",
                live: false,
              },
            ].map((c) => (
              <div
                key={c.title}
                style={{
                  borderRadius: 14,
                  border: "1px solid rgba(30,41,59,.9)",
                  background: "rgba(15,23,42,.5)",
                  padding: "14px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 20 }}>{c.icon}</span>
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 800,
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      color: c.live ? "#34d399" : "#c4b5fd",
                      border: `1px solid ${c.live ? "rgba(52,211,153,.35)" : "rgba(196,181,253,.35)"}`,
                      background: c.live ? "rgba(52,211,153,.08)" : "rgba(196,181,253,.08)",
                      padding: "3px 8px",
                      borderRadius: 9999,
                    }}
                  >
                    {c.status}
                  </span>
                </div>
                <div style={{ marginTop: 8, fontSize: 13, fontWeight: 700, color: "#f1f5f9" }}>{c.title}</div>
                <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5, color: "#94a3b8" }}>{c.body}</div>
              </div>
            ))}
            {/* The story, as a card — thumbnail + link, no autoplay */}
            <a
              href="https://www.youtube.com/watch?v=HjAVZ8fXiIE"
              target="_blank"
              rel="noreferrer"
              style={{
                display: "block",
                borderRadius: 14,
                border: "1px solid rgba(30,41,59,.9)",
                background: "rgba(15,23,42,.5)",
                padding: "14px",
                textDecoration: "none",
              }}
            >
              <div style={{ position: "relative", borderRadius: 10, overflow: "hidden" }}>
                <img
                  src="https://i.ytimg.com/vi/HjAVZ8fXiIE/hqdefault.jpg"
                  alt="What is Voicescape? video thumbnail"
                  style={{ display: "block", width: "100%", aspectRatio: "16 / 9", objectFit: "cover" }}
                />
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 32,
                    color: "#fff",
                    textShadow: "0 2px 12px rgba(0,0,0,.8)",
                  }}
                  aria-hidden
                >
                  ▶
                </span>
              </div>
              <div style={{ marginTop: 8, fontSize: 13, fontWeight: 700, color: "#f1f5f9" }}>
                What is Voicescape? <span style={{ color: "#7dd3fc" }}>↗</span>
              </div>
              <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5, color: "#94a3b8" }}>
                A former cable tech built a verified Hedera mainnet app — the story behind this demo.
              </div>
            </a>
          </div>
        </section>

        {/* MCP tools panel — what the badge opens */}
        {showTools && (
          <div
            onClick={() => setShowTools(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(2,6,23,.75)",
              zIndex: 50,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="step-in"
              style={{
                width: "100%",
                maxWidth: 420,
                background: "#0a0f1e",
                border: "1px solid rgba(56,189,248,.25)",
                borderRadius: 16,
                padding: 20,
                boxShadow: "0 0 60px rgba(56,189,248,.15)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: "#f1f5f9" }}>
                  MCP tools
                </h3>
                <button
                  onClick={() => setShowTools(false)}
                  aria-label="Close"
                  style={{
                    border: "1px solid rgba(148,163,184,.3)",
                    background: "transparent",
                    color: "#94a3b8",
                    borderRadius: 8,
                    padding: "4px 10px",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  ✕
                </button>
              </div>
              <p style={{ marginTop: 8, fontSize: 12, color: "#94a3b8", lineHeight: 1.5 }}>
                64 tools live on Voicescape&apos;s MCP server. This demo touches
                only these read-only ones — the agent never writes, never holds keys.
              </p>
              <ul style={{ marginTop: 12, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
                {[
                  ["lookup_blockpage", "find any blockpage by username"],
                  ["blockpage_earnings", "real tip totals — the 98/2 split, on-chain"],
                  ["list_templates", "live page templates to start from"],
                  ["list_tip_assets", "assets a creator accepts for tips"],
                  ["check_profile_pin", "verify a profile pin"],
                ].map(([name, desc]) => (
                  <li
                    key={name}
                    style={{
                      borderRadius: 10,
                      border: "1px solid rgba(30,41,59,.9)",
                      background: "rgba(15,23,42,.6)",
                      padding: "10px 12px",
                    }}
                  >
                    <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, fontWeight: 700, color: "#7dd3fc" }}>
                      {name}
                    </div>
                    <div style={{ marginTop: 2, fontSize: 11, color: "#94a3b8" }}>{desc}</div>
                  </li>
                ))}
              </ul>
              {/* The guide — what "live" actually means, in plain language */}
              <div
                style={{
                  marginTop: 12,
                  borderRadius: 10,
                  border: "1px solid rgba(52,211,153,.25)",
                  background: "rgba(52,211,153,.05)",
                  padding: "10px 12px",
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6ee7b7" }}>
                  ⛓ What &ldquo;live&rdquo; means here
                </div>
                {blockNum && (
                  <div style={{ marginTop: 8, fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#7dd3fc" }}>
                    <span className="live-dot" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 9999, background: "#34d399", marginRight: 8 }} />
                    Hedera mainnet · block #{blockNum}
                  </div>
                )}
                <p style={{ marginTop: 6, marginBottom: 0, fontSize: 11, lineHeight: 1.6, color: "#94a3b8" }}>
                  This demo&apos;s voice agent talks to the same MCP server our
                  production dapp runs on — 64 tools, spec 2025-11-25, over
                  Streamable HTTP. Every call above hits the real server: real
                  blockpages, real tip totals, real templates. Nothing is mocked.
                  Tips settle on Hedera mainnet — the chain seals a new block
                  every few seconds, and the 98/2 split is enforced by the smart
                  contract itself, not by trust.
                </p>
              </div>
              {agent && agent.toolResults.length > 0 && (
                <p style={{ marginTop: 12, fontSize: 12, color: "#34d399" }}>
                  ⚡ This session called {agent.toolResults.length}: {agent.toolResults.map((t) => t.tool).join(", ")}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <footer style={{ margin: "36px auto 0", maxWidth: 576, textAlign: "center", fontSize: 11, lineHeight: 1.7, color: "#475569" }}>
          <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 12 }}>
            One hub for humans and AI agents — voice is the newest door in.
          </p>
          <p style={{ marginBottom: 16 }}>
            <a
              href="https://github.com/VoiceScapee/voicescape/tree/danny/alexa-hackathon-voice-builder"
              target="_blank"
              rel="noreferrer"
              style={{ color: "#7dd3fc", textDecoration: "underline", textUnderlineOffset: 3 }}
            >
              Open source — read every line of this demo
            </a>
          </p>
          <a
            href="https://hedera.com"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Built on Hedera"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              textDecoration: "none",
              color: "#94a3b8",
              marginBottom: 8,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600 }}>Built on</span>
            <img
              src={HEDERA_LOGO_DATA}
              alt="Hedera"
              width={86}
              height={24}
              draggable={false}
              style={{ display: "block", height: 18, width: "auto", userSelect: "none" }}
            />
          </a>
          <p style={{ marginTop: 8, opacity: 0.8 }}>
            Voicescape is an independent project — not affiliated with,
            sponsored, or endorsed by Hedera Hashgraph, LLC.
          </p>
          <p style={{ marginTop: 12 }}>
            Simulated Alexa+ experience · demo preview only — no wallet, no
            claiming, no payments. The agent calls Voicescape&apos;s live MCP
            server; the server never holds keys.
          </p>
        </footer>
      </div>
    </main>
  );
}
