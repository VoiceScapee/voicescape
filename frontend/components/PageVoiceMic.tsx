/**
 * PageVoiceMic — a per-blockpage voice mic (production).
 *
 * One subtle floating button on every blockpage: the visitor taps, speaks
 * ("play their music", "are they live?", "leave a tip"), and a page-scoped
 * agent answers from the page's live blocks via /api/page-voice — spoken
 * back with the browser's own voices, no login, no wallet, no Buddy widget.
 * Suggestion chips are generated from the page's ACTUAL blocks; actions
 * scroll to the block's anchor or deep-link the tip box (?tip=1).
 *
 * Speech I/O is the browser Web Speech API ($0). The getVoices() race is
 * handled: we wait for onvoiceschanged before picking the language-matched
 * voice instead of reading an empty list on first paint.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { LANGS, type Lang } from "@/lib/i18n/dictionaries";
import type { VoicescapePage } from "@/lib/schema";
import {
  clampMicPos,
  loadMicPos,
  saveMicPos,
  type MicPos,
} from "@/lib/voice-mic-position";
import {
  dappSectionChips,
  dappSectionFooter,
  dappSectionTitle,
  type DappSection,
} from "@/lib/voice-dapp-chips";

/* Minimal Web Speech API typings (browser-provided, no dependency). */
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

const BCP47: Record<Lang, string> = {
  en: "en-US",
  es: "es-ES",
  zh: "zh-CN",
  ja: "ja-JP",
  ko: "ko-KR",
  vi: "vi-VN",
  id: "id-ID",
  th: "th-TH",
  tl: "fil-PH",
  tr: "tr-TR",
  hi: "hi-IN",
  ar: "ar-SA",
  pt: "pt-BR",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  sv: "sv-SE",
  lt: "lt-LT",
  ro: "ro-RO",
  ms: "ms-MY",
};

interface VoiceAction {
  scrollTo?: string;
  openTip?: boolean;
  /** Builder surface only: the builder page switches to its AI tab. */
  builderAi?: boolean;
}

/**
 * Custom SVG iconography — no emoji. The mic is the dapp's signature
 * intelligent-UI element; it gets drawn, not emoji'd.
 */
function MicSvg({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="17" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}

function StopSvg({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx={2.5} />
    </svg>
  );
}

function XSvg({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}
interface VoiceReply {
  ok: boolean;
  speak: string;
  steps: string[];
  action?: VoiceAction;
  error?: string;
}

/** Chips only for blocks the page actually has — never hardcoded prompts. */
function suggestionChips(page: VoicescapePage, lang: Lang): string[] {
  const types = new Set(page.blocks.map((b) => b.type));
  const es = lang === "es";
  const chips: string[] = [];
  if (types.has("music")) chips.push(es ? "Pon su música" : "Play their music");
  if (types.has("livestream")) chips.push(es ? "¿Están en vivo?" : "Are they live?");
  if (types.has("bio") || types.has("hero")) chips.push(es ? "Su historia" : "Their story");
  if (types.has("gallery")) chips.push(es ? "Ver fotos" : "Show photos");
  if (types.has("links") || types.has("socials")) chips.push(es ? "Sus enlaces" : "Their links");
  if (types.has("booking")) chips.push(es ? "Reservar" : "Book them");
  if (types.has("tipJar")) chips.push(es ? "Dar propina" : "Leave a tip");
  return chips.slice(0, 4);
}

/**
 * Pick the best voice for a language. getVoices() is async on first load
 * (Chrome populates it after onvoiceschanged) — wait for it instead of
 * reading an empty list and falling back to the wrong language.
 */
function resolveVoice(code: string): Promise<SpeechSynthesisVoice | undefined> {
  const pick = (voices: SpeechSynthesisVoice[]) =>
    voices.find((v) => v.lang.toLowerCase().startsWith(code.toLowerCase())) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(code.split("-")[0].toLowerCase()));
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) {
      resolve(undefined);
      return;
    }
    const synth = window.speechSynthesis;
    if (synth.getVoices().length > 0) {
      resolve(pick(synth.getVoices()));
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      synth.onvoiceschanged = null;
      resolve(pick(synth.getVoices()));
    };
    synth.onvoiceschanged = finish;
    setTimeout(finish, 1200); // never wait forever on platforms that don't fire it
  });
}

export default function PageVoiceMic({
  username,
  page,
  dappSection,
}: {
  /** Null in dapp mode (the mic on dapp surfaces): answers general
      Voicescape questions via the API's dapp mode. */
  username: string | null;
  /** Null while the page is still resolving (or failed to) — the button
      still renders; chips wait for the page, and the API re-resolves
      server-side from the username. */
  page: VoicescapePage | null;
  /** Dapp mode only: which surface the mic is on — picks the per-surface
      chips/title ("builder" = the two-path choice). Defaults to "home". */
  dappSection?: DappSection | null;
}) {
  const dappMode = !username;
  const section: DappSection = dappMode ? (dappSection ?? "home") : "home";
  const router = useRouter();
  const { lang: dappLang } = useLanguage();
  const [lang, setLang] = useState<Lang>(dappLang);
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastHeard, setLastHeard] = useState("");
  const [lastSaid, setLastSaid] = useState("");
  const recogRef = useRef<SpeechRecognitionLike | null>(null);

  // Draggable position. Null = the default bottom-left spot. Loaded from
  // localStorage after mount (never during SSR — avoids hydration mismatch).
  const [pos, setPos] = useState<MicPos | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) setSupported(false);
    setPos(loadMicPos());
    return () => {
      recogRef.current?.abort();
      window.speechSynthesis?.cancel();
    };
  }, []);

  const onDragStart = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const origin = pos ?? { x: 20, y: window.innerHeight - 72 };
      dragRef.current = { startX: e.clientX, startY: e.clientY, origX: origin.x, origY: origin.y };
      movedRef.current = false;
      setDragging(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture can throw for mouse in odd states — drag still works.
      }
    },
    [pos],
  );

  const onDragMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.hypot(dx, dy) > 6) movedRef.current = true;
    if (movedRef.current) {
      setPos(clampMicPos(d.origX + dx, d.origY + dy, window.innerWidth, window.innerHeight));
    }
  }, []);

  const onDragEnd = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (d && movedRef.current) {
      const finalPos = clampMicPos(
        d.origX + (e.clientX - d.startX),
        d.origY + (e.clientY - d.startY),
        window.innerWidth,
        window.innerHeight,
      );
      setPos(finalPos);
      saveMicPos(finalPos);
    }
  }, []);

  const speak = useCallback(
    async (text: string) => {
      if (!("speechSynthesis" in window) || !text) return;
      window.speechSynthesis.cancel();
      const voice = await resolveVoice(lang);
      const u = new SpeechSynthesisUtterance(text);
      u.lang = BCP47[lang] ?? "en-US";
      u.rate = 1.02;
      if (voice) u.voice = voice;
      window.speechSynthesis.speak(u);
    },
    [lang],
  );

  const runAction = useCallback(
    (action?: VoiceAction) => {
      if (!action) return;
      if (action.scrollTo) {
        document
          .querySelector(`[data-pv-block="${action.scrollTo}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      if (action.openTip && username) {
        // ?tip=1 is the page's own deep link for the tip box. When it's
        // already in the URL (box was closed), add a nonce so the page's
        // effect refires and reopens it. Close the voice panel so it never
        // sits over the tip flow. Dapp mode never returns tip actions.
        const hasTip = new URLSearchParams(window.location.search).get("tip") === "1";
        setOpen(false);
        router.push(hasTip ? `/${username}?tip=1&pvvoice=${Date.now()}` : `/${username}?tip=1`);
      }
      if (action.builderAi) {
        // Builder surface only: the builder page listens for this and
        // switches to its AI tab. No listener anywhere else, so this is
        // a harmless no-op off the builder.
        window.dispatchEvent(new CustomEvent("vs:open-builder-ai"));
      }
    },
    [router, username],
  );

  const ask = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || busy) return;
      setBusy(true);
      setError(null);
      setLastHeard(prompt);
      try {
        const res = await fetch("/api/page-voice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: prompt,
            lang,
            // Omitted in dapp mode — the API answers general questions.
            // dappSection lets the API attach surface-only actions
            // (builderAi) where they actually work.
            ...(username ? { username } : { dappSection: section }),
            navigatorLang: typeof navigator !== "undefined" ? navigator.language : undefined,
          }),
        });
        const data = (await res.json()) as VoiceReply;
        if (!res.ok || !data.ok) throw new Error(data.error ?? "voice agent failed");
        setLastSaid(data.speak);
        runAction(data.action);
        void speak(data.speak);
      } catch (e) {
        setError(e instanceof Error ? e.message : "something went wrong");
      } finally {
        setBusy(false);
      }
    },
    [busy, lang, username, section, runAction, speak],
  );

  const startListening = useCallback(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) {
      setSupported(false);
      return;
    }
    window.speechSynthesis?.cancel();
    const recog = new SR();
    recog.lang = BCP47[lang] ?? "en-US";
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
        setError("Mic blocked — allow microphone access or type below.");
      } else if (code === "audio-capture") {
        setError(
          "The mic is busy — if you're screen recording with microphone audio, " +
            "switch the recorder to internal audio only, or type below instead.",
        );
      } else if (code !== "no-speech" && code !== "aborted") {
        setError("Didn't catch that — try again or type it.");
      }
    };
    recog.onend = () => {
      setListening(false);
      recogRef.current = null;
      if (finalText.trim()) void ask(finalText);
    };
    recogRef.current = recog;
    setTranscript("");
    setError(null);
    setListening(true);
    try {
      recog.start();
    } catch {
      setListening(false);
      recogRef.current = null;
      setError("Mic couldn't start — type below instead.");
    }
  }, [ask, lang]);

  const chips = dappMode ? dappSectionChips(section, lang) : page ? suggestionChips(page, lang) : [];

  const panelTitle = dappMode ? dappSectionTitle(section) : "Talk to this page";
  const footerNote = dappMode
    ? dappSectionFooter(section)
    : "Answers come from this page's live blocks. Tips open in your wallet — nothing moves on its own.";

  // When the mic sits in the top half of the screen, the panel opens
  // BELOW the button so it never clips off the top edge.
  const panelBelow = pos !== null && typeof window !== "undefined" && pos.y < window.innerHeight * 0.5;

  return (
    <div
      style={{
        position: "fixed",
        ...(pos
          ? { left: pos.x, top: pos.y }
          : { left: 20, bottom: "calc(env(safe-area-inset-bottom, 0px) + 20px)" }),
        zIndex: 60,
        display: "flex",
        flexDirection: panelBelow ? "column-reverse" : "column",
        alignItems: "flex-start",
        gap: 10,
        maxWidth: "min(340px, calc(100vw - 40px))",
      }}
    >
      {open && (
        <div
          role="dialog"
          aria-label={panelTitle}
          className="pv-mic-panel"
          style={{
            width: "100%",
            borderRadius: 16,
            padding: 14,
            background: "rgba(12, 16, 24, 0.96)",
            border: "1px solid rgba(255,255,255,0.12)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
            color: "#e8e4da",
            fontSize: 14,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ display: "inline-flex", color: "#ffb14e" }}>
              <MicSvg size={18} />
            </span>
            <span style={{ fontWeight: 600, flex: 1 }}>{panelTitle}</span>
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value as Lang)}
              aria-label="Voice language"
              style={{
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "rgba(255,255,255,0.06)",
                color: "#e8e4da",
                padding: "4px 6px",
                fontSize: 12,
                maxWidth: 120,
              }}
            >
              {LANGS.map((l) => (
                <option key={l.code} value={l.code} style={{ color: "#111" }}>
                  {l.nativeLabel}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                window.speechSynthesis?.cancel();
              }}
              aria-label="Close voice panel"
              className="pv-icon-btn"
              style={{ color: "#9aa" }}
            >
              <XSvg size={15} />
            </button>
          </div>

          {!supported && (
            <p style={{ fontSize: 12, color: "#fbbf24", marginBottom: 8 }}>
              Voice input isn&apos;t supported in this browser — type below.
            </p>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                disabled={busy}
                onClick={() => void ask(c)}
                className="pv-chip"
                style={{
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "rgba(255,255,255,0.05)",
                  color: "#e8e4da",
                  padding: "5px 10px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {c}
              </button>
            ))}
          </div>

          {(lastHeard || lastSaid) && (
            <div style={{ marginBottom: 10, fontSize: 13, lineHeight: 1.45 }}>
              {lastHeard && (
                <p style={{ opacity: 0.75, margin: "0 0 4px" }}>“{lastHeard}”</p>
              )}
              {lastSaid && <p style={{ margin: 0 }}>{lastSaid}</p>}
            </div>
          )}

          <button
            type="button"
            onClick={listening ? () => recogRef.current?.stop() : startListening}
            disabled={busy}
            style={{
              width: "100%",
              borderRadius: 12,
              border: "none",
              padding: "10px 12px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              background: listening ? "#ef4444" : "#e8e4da",
              color: listening ? "#fff" : "#111",
              marginBottom: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            {listening ? <StopSvg size={15} /> : !busy ? <MicSvg size={17} /> : null}
            {listening ? "Stop listening" : busy ? "…" : "Tap and speak"}
          </button>
          {transcript && listening && (
            <p style={{ fontSize: 13, opacity: 0.8, margin: "0 0 8px" }}>“{transcript}”</p>
          )}

          <form
            style={{ display: "flex", gap: 6 }}
            onSubmit={(e) => {
              e.preventDefault();
              void ask(typed);
              setTyped("");
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Or type here…"
              aria-label="Type your question"
              style={{
                flex: 1,
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "rgba(255,255,255,0.06)",
                color: "#e8e4da",
                padding: "8px 10px",
                fontSize: 13,
              }}
            />
            <button
              type="submit"
              disabled={busy}
              style={{
                borderRadius: 10,
                border: "none",
                background: "#e8e4da",
                color: "#111",
                padding: "8px 12px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Ask
            </button>
          </form>

          {error && <p style={{ fontSize: 12, color: "#fca5a5", margin: "8px 0 0" }}>{error}</p>}
          <p style={{ fontSize: 11, opacity: 0.55, margin: "8px 0 0" }}>{footerNote}</p>
        </div>
      )}

      <button
        type="button"
        className={`pv-mic-btn${listening ? " is-listening" : ""}`}
        onClick={() => {
          // A real drag ends with the pointer capture released — plain taps
          // (and keyboard Enter/Space, which fire click without pointers)
          // toggle the panel; drags don't.
          if (movedRef.current) {
            movedRef.current = false;
            return;
          }
          setOpen((v) => !v);
        }}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        aria-label={open ? "Close page voice" : panelTitle}
        title={`${panelTitle} — drag to move`}
        style={{
          width: 52,
          height: 52,
          borderRadius: "50%",
          border: "1px solid rgba(255,255,255,0.2)",
          background: listening ? "#ef4444" : "rgba(12, 16, 24, 0.92)",
          color: "#e8e4da",
          cursor: dragging ? "grabbing" : "grab",
          touchAction: "none",
          boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        {listening ? <StopSvg size={20} /> : <MicSvg size={24} />}
      </button>
    </div>
  );
}
