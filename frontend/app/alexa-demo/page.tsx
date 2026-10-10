"use client";

/**
 * /alexa-demo — Voicescape Voice Builder (hackathon demo).
 *
 * Simulated Alexa+ experience for the Amazon Build, Ship, Shape hackathon:
 * speak a prompt, the agent plans over our LIVE MCP server and a blockpage
 * preview builds itself on screen. Demo branch only — never merged to master.
 * No wallet, no claiming, no money movement: the result is a preview draft.
 */

import { useCallback, useEffect, useRef, useState } from "react";

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
      <div className="p-6 text-center">
        <div
          className="mx-auto flex h-16 w-16 items-center justify-center rounded-full text-3xl"
          style={{ background: `${accent}26`, color: accent }}
        >
          {str(block.avatarEmoji) || "🎸"}
        </div>
        <h3 className="mt-3 text-xl font-bold">{str(block.title) || "Your page"}</h3>
        {str(block.subtitle) && <p className="mt-1 text-sm opacity-70">{str(block.subtitle)}</p>}
      </div>
    );
  }
  if (type === "bio") {
    return <p className="px-6 py-2 text-center text-sm opacity-80">{str(block.text)}</p>;
  }
  if (type === "music") {
    const tracks = Array.isArray(block.tracks) ? block.tracks : [];
    return (
      <div className="mx-4 mt-3 rounded-lg px-4 py-3 text-sm" style={{ background: `${accent}14` }}>
        <p className="font-semibold">🎶 {str(block.title) || "Music"}</p>
        {str(block.note) && <p className="mt-1 opacity-70">{str(block.note)}</p>}
        {tracks.map((t, i) => (
          <p key={i} className="mt-1 truncate opacity-80">
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
      <div className="mx-4 mt-3 overflow-hidden rounded-lg" style={{ border: `1px solid ${accent}44` }}>
        <div className="aspect-video w-full">
          <iframe
            className="h-full w-full"
            src={src}
            title={str(block.title) || "Live stream"}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        </div>
        {str(block.title) && (
          <p className="px-3 py-2 text-center text-xs font-semibold" style={{ color: accent }}>
            🔴 {str(block.title)}
          </p>
        )}
      </div>
    );
  }
  if (type === "tipJar") {
    return (
      <div
        className="mx-4 mt-3 rounded-lg px-4 py-3 text-center text-sm"
        style={{ border: `1px dashed ${accent}88`, color: accent }}
      >
        💰 {str(block.message)}
      </div>
    );
  }
  if (type === "links") {
    const items = Array.isArray(block.items) ? block.items : [];
    return (
      <div className="mx-4 mt-3 flex flex-wrap justify-center gap-2">
        {items.map((it, i) => {
          const item = it as Record<string, unknown>;
          return (
            <span
              key={i}
              className="rounded-full px-3 py-1 text-xs"
              style={{ background: `${accent}1f`, color: accent }}
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
      <div className="mt-3 flex justify-center gap-3 px-4 text-2xl">
        {images.map((img, i) => (
          <span key={i}>{str(img)}</span>
        ))}
      </div>
    );
  }
  // Legacy planner shape: {type:"text", content}
  if (str(block.content)) {
    return (
      <div className="mx-4 mt-3 rounded-lg px-4 py-3 text-sm" style={{ background: `${accent}14` }}>
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
  // spoken into existence.
  useEffect(() => {
    if (!previewReady || blocksDone) return;
    const t = setTimeout(() => setVisibleBlocks((v) => v + 1), 550);
    return () => clearTimeout(t);
  }, [previewReady, blocksDone, blocks.length]);

  return (
    <main
      className="relative min-h-screen overflow-hidden px-4 py-10 text-slate-200"
      style={{ background: "#020617" }}
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
      `}</style>
      <div className="relative mx-auto max-w-3xl">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] uppercase tracking-[0.2em] text-sky-400">
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
            marginTop: 12,
            fontSize: "2.6rem",
            lineHeight: 1.1,
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
        <p className="mt-3 max-w-xl text-slate-400">
          Voicescape Voice Builder — tap the mic. The agent plans over
          Voicescape&apos;s live MCP server, then your blockpage preview builds
          itself.
        </p>

        {/* Identity strip — who this is for */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
          {[
            ["Alexa+ track", "simulated experience"],
            ["Hedera mainnet", "live"],
            ["Hedera Agent Kit", "v4"],
            ["MCP", "spec 2025-11-25"],
          ].map(([name, sub]) => (
            <span
              key={name}
              style={{
                display: "inline-flex",
                alignItems: "baseline",
                gap: 6,
                borderRadius: 9999,
                border: "1px solid rgba(148,163,184,.25)",
                background: "rgba(148,163,184,.07)",
                padding: "5px 12px",
                fontSize: 11,
                color: "#cbd5e1",
              }}
            >
              <strong style={{ fontWeight: 700, color: "#f1f5f9" }}>{name}</strong>
              <span style={{ color: "#94a3b8" }}>{sub}</span>
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Works today on any device with a browser and a mic — phone, PC,
          tablet. Voice builds it, you claim it on the dapp.
        </p>
        <div className="mt-3 flex items-center gap-2 text-sm text-slate-400">
          <span aria-hidden>🌐</span>
          <label htmlFor="voice-lang" className="text-xs uppercase tracking-widest text-slate-500">
            Voice language
          </label>
          <select
            id="voice-lang"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100"
          >
            {VOICE_LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>

        {/* Voice button */}
        <div className="mt-10 flex flex-col items-center gap-4">
          <div className="relative">
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
                width: 128,
                height: 128,
                minWidth: 128,
                minHeight: 128,
                borderRadius: 9999,
                fontSize: 52,
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
                  ? "0 0 60px rgba(239,68,68,.45)"
                  : "0 0 60px rgba(56,189,248,.35)",
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
            <p className="text-sm text-slate-400">
              {busy ? "Agent is building…" : "Tap and speak"}
            </p>
          )}
          {!supported && (
            <p className="text-sm text-amber-300">
              Voice input isn&apos;t supported in this browser — type below.
            </p>
          )}
          {transcript && (
            <p className="preview-in text-center text-xl text-slate-100">“{transcript}”</p>
          )}

          {/* Type fallback */}
          <form
            className="flex w-full max-w-xl gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              runAgent(typed);
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Or type your prompt…"
              className="flex-1 rounded-xl border border-slate-700/80 bg-slate-900/80 px-4 py-2.5 text-slate-100 backdrop-blur placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy}
              className="glow-btn rounded-xl bg-sky-400 px-5 py-2.5 font-semibold text-slate-950 disabled:opacity-50"
            >
              Build
            </button>
          </form>

          <div className="flex flex-wrap justify-center gap-2">
            {DEMO_SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => runAgent(s)}
                disabled={busy}
                className="glow-btn rounded-full border border-slate-700/80 bg-slate-900/60 px-4 py-1.5 text-xs text-slate-300 backdrop-blur hover:border-sky-500/60 hover:text-sky-200 disabled:opacity-50"
              >
                ✨ {s}
              </button>
            ))}
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-500">
            <input
              type="checkbox"
              checked={autoSpeak}
              onChange={(e) => setAutoSpeak(e.target.checked)}
              className="accent-sky-400"
            />
            Speak the agent&apos;s reply out loud
          </label>
        </div>

        {error && (
          <p className="mx-auto mt-6 max-w-xl rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300 backdrop-blur">
            {error}
          </p>
        )}

        {/* Agent terminal — the orchestration, made visible */}
        {agent && (
          <section className="mx-auto mt-12 max-w-xl">
            <div
              className="overflow-hidden rounded-2xl border border-slate-800"
              style={{ background: "#05070d", boxShadow: "0 0 50px rgba(56,189,248,.07), 0 25px 50px -12px rgba(0,0,0,.7)" }}
            >
              {/* Title bar */}
              <div
                className="flex items-center gap-2 border-b border-slate-800/80 px-4 py-2.5"
                style={{ background: "#0a0d16" }}
              >
                <span style={{ width: 11, height: 11, borderRadius: 9999, background: "#f87171" }} />
                <span style={{ width: 11, height: 11, borderRadius: 9999, background: "#fbbf24" }} />
                <span style={{ width: 11, height: 11, borderRadius: 9999, background: "#34d399" }} />
                <span className="ml-2 font-mono text-xs text-slate-500">
                  agent — live MCP session
                </span>
                <span
                  className="ml-auto flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-emerald-400"
                >
                  <span className="live-dot" style={{ display: "inline-block", width: 7, height: 7, borderRadius: 9999, background: "#34d399" }} />
                  live
                </span>
              </div>
              {/* Body */}
              <div className="space-y-1.5 p-4 font-mono text-[13px] leading-relaxed">
                {agent.steps.slice(0, visibleSteps).map((s, i) => (
                  <div key={i} className="step-in">
                    <span className="mr-2 select-none text-slate-600">$</span>
                    <span className="text-slate-300">
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
                    <span className="ml-2 text-emerald-400">✓</span>
                  </div>
                ))}
                {(busy || visibleSteps < agent.steps.length) && (
                  <div>
                    <span className="mr-2 select-none text-slate-600">$</span>
                    <span className="cursor-blink text-emerald-400">▊</span>
                  </div>
                )}
                {previewReady && blocksDone && (
                  <div className="step-in">
                    <span className="mr-2 select-none text-slate-600">$</span>
                    <span style={{ color: "#6ee7b7", fontWeight: 600 }}>
                      blockpage materialized ✨
                    </span>
                  </div>
                )}
              </div>
              {/* Status bar */}
              {agent.mcp && visibleSteps >= agent.steps.length && (
                <div
                  className="border-t border-slate-800/80 px-4 py-2 font-mono text-[10px] text-slate-600"
                  style={{ background: "#0a0d16" }}
                >
                  {agent.mcp.serverName} · MCP {agent.mcp.protocolVersion} · Streamable HTTP · zero mocking
                  {agent.toolResults.length > 0 &&
                    ` · tools: ${agent.toolResults.map((t) => t.tool).join(", ")}`}
                </div>
              )}
            </div>
          </section>
        )}

        {/* Blockpage preview — builds itself */}
        {agent && visibleSteps >= agent.steps.length && (
          <section className="mx-auto mt-10 max-w-md">
            <h2 className="mb-3 text-center text-xs uppercase tracking-[0.2em] text-slate-500">
              Your blockpage preview
            </h2>
            <div
              className="preview-in overflow-hidden rounded-3xl border shadow-2xl backdrop-blur"
              style={{
                background: bg,
                color: fg,
                borderColor: `${accent}55`,
                fontFamily,
                boxShadow: `0 0 80px ${accent}22, 0 25px 50px -12px rgba(0,0,0,.6)`,
              }}
            >
              <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${accent}, #a78bfa)` }} />
              {!hasHero && (
                <div className="p-6">
                  <div
                    className="mx-auto flex h-16 w-16 items-center justify-center rounded-full text-2xl font-bold"
                    style={{ background: `${accent}26`, color: accent }}
                  >
                    {(agent.pageDraft.displayName ?? "?").slice(0, 1).toUpperCase()}
                  </div>
                  <h3 className="mt-3 text-center text-xl font-bold">
                    {agent.pageDraft.displayName ?? "Your page"}
                  </h3>
                  {agent.pageDraft.purpose && (
                    <p className="mt-2 text-center text-sm opacity-80">{agent.pageDraft.purpose}</p>
                  )}
                </div>
              )}
              {hasHero && agent.pageDraft.purpose && (
                <p className="px-6 pt-4 text-center text-xs opacity-60">{agent.pageDraft.purpose}</p>
              )}
              {blocks.slice(0, visibleBlocks).map((b, i) => (
                <div key={i} className="step-in">
                  <BlockView block={b} accent={accent} />
                </div>
              ))}
              {blocksDone && !hasTipJar && (
                <div
                  className="step-in mx-4 mt-4 rounded-lg px-4 py-3 text-center text-sm font-semibold"
                  style={{ border: `1px dashed ${accent}88`, color: accent }}
                >
                  Tips open on the live dapp — creators keep 98% of every tip
                </div>
              )}
              {blocksDone && (agent.pageDraft.socials ?? []).length > 0 && (
                <div className="step-in mt-4 flex flex-wrap justify-center gap-2">
                  {agent.pageDraft.socials!.map((s, i) => (
                    <span
                      key={i}
                      className="rounded-full px-3 py-1 text-xs"
                      style={{ background: `${accent}1f`, color: accent }}
                    >
                      {s.platform}
                    </span>
                  ))}
                </div>
              )}
              {blocksDone && (agent.pageDraft.links ?? []).length > 0 && (
                <ul className="step-in mt-4 space-y-1 px-6 pb-2 text-sm">
                  {agent.pageDraft.links!.map((l, i) => (
                    <li key={i} className="truncate opacity-80">
                      🔗 {l.label}
                    </li>
                  ))}
                </ul>
              )}
              <div className="h-4" />
            </div>
            {blocksDone && (
              <p
                className="step-in mt-4 text-center text-sm font-semibold"
                style={{
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
              <p className="mt-3 text-center text-xs text-slate-500">{agent.disclaimer}</p>
            )}
            <div className="mt-4 text-center">
              <a
                href="https://voicescape.vercel.app"
                target="_blank"
                rel="noreferrer"
                className="glow-btn inline-block rounded-xl bg-sky-400 px-5 py-2.5 font-semibold text-slate-950"
              >
                Make it yours on the live dapp →
              </a>
              <p className="mt-2 text-xs text-slate-500">
                Claiming happens in your own wallet — the agent previews, you own it.
              </p>
            </div>
          </section>
        )}

        {/* Footer */}
        <footer className="mx-auto mt-16 max-w-xl text-center text-[11px] leading-relaxed text-slate-600">
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
