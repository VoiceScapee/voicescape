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
    return (
      <div className="mx-4 mt-3 overflow-hidden rounded-lg" style={{ border: `1px solid ${accent}44` }}>
        <div className="aspect-video w-full">
          <iframe
            className="h-full w-full"
            src={`https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(str(block.channel))}&autoplay=1&mute=1&rel=0`}
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
  "Build me a blockpage for my music",
  "Make a page for my photography portfolio",
  "Look up the blockpage user-10424063",
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
  const [autoSpeak, setAutoSpeak] = useState(true);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) setSupported(false);
    return () => {
      recogRef.current?.abort();
      window.speechSynthesis?.cancel();
    };
  }, []);

  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
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
      try {
        const res = await fetch("/api/alexa-demo/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: prompt }),
        });
        const data = (await res.json()) as AgentResponse;
        if (!res.ok) throw new Error(data.error ?? "agent failed");
        setAgent(data);
        if (autoSpeak && data.speak) speak(data.speak);
      } catch (e) {
        setError(e instanceof Error ? e.message : "something went wrong");
      } finally {
        setBusy(false);
      }
    },
    [busy, autoSpeak, speak]
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
    recog.lang = "en-US";
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
      setListening(false);
      setError(e.error === "not-allowed" ? "Mic blocked — allow microphone access or type your prompt." : "Didn't catch that — try again or type it.");
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
  }, [runAgent]);

  const theme = agent?.pageDraft.theme ?? {};
  const bg = theme.background ?? "#0f172a";
  const fg = theme.foreground ?? "#f1f5f9";
  const accent = theme.accent ?? "#38bdf8";
  const fontFamily = theme.fontFamily ?? "inherit";
  const blocks = (agent?.pageDraft.blocks ?? []) as Array<Record<string, unknown>>;
  const hasTipJar = blocks.some((b) => b.type === "tipJar");
  const hasHero = blocks.some((b) => b.type === "hero");

  return (
    <main
      style={{ background: "#020617", color: "#e2e8f0", minHeight: "100vh" }}
      className="px-4 py-10"
    >
      <div className="mx-auto max-w-3xl">
        <p className="text-xs uppercase tracking-widest" style={{ color: accent }}>
          Amazon hackathon demo · Alexa+ track · simulated experience
        </p>
        <h1 className="mt-2 text-3xl font-bold">Voicescape Voice Builder</h1>
        <p className="mt-2 text-slate-400">
          Speak a prompt. The agent plans over Voicescape&apos;s live MCP server
          and your blockpage preview builds itself.
        </p>
        <p className="mt-2 text-xs text-slate-500">
          Works today on any device with a browser and a mic — phone, PC,
          tablet. Voice builds it, you claim it on the dapp.
        </p>

        {/* Voice button */}
        <div className="mt-8 flex flex-col items-center gap-4">
          <button
            onClick={listening ? () => recogRef.current?.stop() : startListening}
            disabled={busy}
            aria-label={listening ? "Stop listening" : "Start voice prompt"}
            style={{
              background: listening ? "#ef4444" : accent,
              boxShadow: listening ? "0 0 0 12px rgba(239,68,68,.18)" : `0 0 0 12px ${accent}22`,
            }}
            className="h-28 w-28 rounded-full text-4xl text-slate-950 transition-transform active:scale-95 disabled:opacity-50"
          >
            {listening ? "⏹" : "🎙"}
          </button>
          <p className="text-sm text-slate-400">
            {listening ? "Listening… tap to stop" : busy ? "Building…" : "Tap and speak"}
          </p>
          {!supported && (
            <p className="text-sm text-amber-300">
              Voice input isn&apos;t supported in this browser — type below.
            </p>
          )}
          {transcript && <p className="text-center text-lg">“{transcript}”</p>}

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
              className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-slate-100"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg px-4 py-2 font-semibold text-slate-950 disabled:opacity-50"
              style={{ background: accent }}
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
                className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={autoSpeak}
              onChange={(e) => setAutoSpeak(e.target.checked)}
            />
            Speak the agent&apos;s reply out loud
          </label>
        </div>

        {error && (
          <p className="mx-auto mt-6 max-w-xl rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </p>
        )}

        {/* Agent build log */}
        {agent && (
          <section className="mx-auto mt-10 max-w-xl">
            <h2 className="text-sm uppercase tracking-widest text-slate-500">Agent build log</h2>
            <ul className="mt-3 space-y-2">
              {agent.steps.slice(0, visibleSteps).map((s, i) => (
                <li key={i} className="rounded-lg bg-slate-900 px-4 py-2 text-sm">
                  <span style={{ color: accent }}>✓</span> {s}
                </li>
              ))}
            </ul>
            {agent.mcp && visibleSteps >= agent.steps.length && (
              <p className="mt-3 text-xs text-slate-500">
                Live MCP: {agent.mcp.serverName} · spec {agent.mcp.protocolVersion} ·
                Streamable HTTP
                {agent.toolResults.length > 0 &&
                  ` · tools called: ${agent.toolResults.map((t) => t.tool).join(", ")}`}
              </p>
            )}
          </section>
        )}

        {/* Blockpage preview */}
        {agent && visibleSteps >= agent.steps.length && (
          <section className="mx-auto mt-8 max-w-md">
            <h2 className="mb-3 text-sm uppercase tracking-widest text-slate-500">
              Your blockpage preview
            </h2>
            <div
              className="overflow-hidden rounded-2xl border shadow-2xl"
              style={{ background: bg, color: fg, borderColor: `${accent}44`, fontFamily }}
            >
              <div className="h-2" style={{ background: accent }} />
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
              {blocks.map((b, i) => (
                <BlockView key={i} block={b} accent={accent} />
              ))}
              {!hasTipJar && (
                <div
                  className="mx-4 mt-4 rounded-lg px-4 py-3 text-center text-sm font-semibold"
                  style={{ border: `1px dashed ${accent}88`, color: accent }}
                >
                  Tips open on the live dapp — creators keep 98% of every tip
                </div>
              )}
              {(agent.pageDraft.socials ?? []).length > 0 && (
                <div className="mt-4 flex flex-wrap justify-center gap-2">
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
              {(agent.pageDraft.links ?? []).length > 0 && (
                <ul className="mt-4 space-y-1 px-6 pb-2 text-sm">
                  {agent.pageDraft.links!.map((l, i) => (
                    <li key={i} className="truncate opacity-80">
                      🔗 {l.label}
                    </li>
                  ))}
                </ul>
              )}
              <div className="h-4" />
            </div>
            {agent.disclaimer && (
              <p className="mt-3 text-center text-xs text-slate-500">{agent.disclaimer}</p>
            )}
            <div className="mt-4 text-center">
              <a
                href="https://voicescape.vercel.app"
                target="_blank"
                rel="noreferrer"
                className="inline-block rounded-lg px-5 py-2.5 font-semibold text-slate-950"
                style={{ background: accent }}
              >
                Make it yours on the live dapp →
              </a>
              <p className="mt-2 text-xs text-slate-500">
                Claiming happens in your own wallet — the agent previews, you own it.
              </p>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
