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
  "Make a page for my photography portfolio",
  "Look up the blockpage user-10424063",
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

  const langEntry = VOICE_LANGS.find((l) => l.code === lang) ?? VOICE_LANGS[0];
  const recogRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) setSupported(false);
    return () => {
      recogRef.current?.abort();
      window.speechSynthesis?.cancel();
    };
  }, []);

  const speak = useCallback((text: string, bcp47: string, code: string) => {
    if (!("speechSynthesis" in window)) return;
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

  const runAgent = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || busy) return;
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
          body: JSON.stringify({ transcript: prompt, lang: code }),
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
    [busy, autoSpeak, speak, langEntry]
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
  }, [runAgent, langEntry]);

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
    const t = setTimeout(() => setVisibleBlocks((v) => v + 1), 550);
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
           overshoots slightly, and flashes as it clicks into place —
           a blockchain being pieced together, for real. */
        .block-lands { animation: block-snap .55s cubic-bezier(.2,.9,.3,1.12) both; }
        @keyframes block-snap {
          0% {
            opacity: 0;
            transform: translate(var(--enter-x, -30px), 14px) rotate(-1.2deg) scale(.97);
            filter: brightness(1.7);
          }
          55% {
            opacity: 1;
            transform: translate(0, 0) rotate(0deg) scale(1.012);
            filter: brightness(1.12);
          }
          100% {
            opacity: 1;
            transform: translate(0, 0) rotate(0deg) scale(1);
            filter: brightness(1);
          }
        }
      `}</style>
      <div style={{ position: "relative", margin: "0 auto", maxWidth: 768 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.2em", color: "#38bdf8", margin: 0 }}>
            Amazon hackathon · Alexa+ track
          </p>
          <p
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
            }}
          >
            <span className="live-dot" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 9999, background: "#34d399" }} />
            LIVE MCP · 64 tools
          </p>
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
                fontSize: 15,
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
                  borderRadius: 9999,
                  border: "1px solid rgba(51,65,85,.8)",
                  background: "rgba(15,23,42,.6)",
                  padding: "6px 16px",
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
                <span style={{ fontSize: 10, letterSpacing: "0.22em", fontWeight: 800, color: "#7dd3fc" }}>
                  VOICESCAPE AGENT
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
                  <div className="step-in">
                    <span style={{ marginRight: 8, color: "#475569", userSelect: "none" }}>$</span>
                    <span style={{ color: "#6ee7b7", fontWeight: 600 }}>
                      blockpage materialized ✨
                    </span>
                  </div>
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
                  style={{ "--enter-x": i % 2 === 0 ? "-34px" : "34px" } as CSSProperties}
                >
                  <BlockView block={b} accent={accent} />
                </div>
              ))}
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
                className="step-in"
                style={{
                  marginTop: 16,
                  textAlign: "center",
                  fontSize: 14,
                  fontWeight: 600,
                  background: "linear-gradient(90deg, #7dd3fc, #c4b5fd)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                ✨ spoken into existence
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
              <p style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
                Claiming happens in your own wallet — the agent previews, you own it.
              </p>
            </div>
            </>
          )}
          </section>

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
              src="/hedera-logo.svg"
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
