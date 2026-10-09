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
}: {
  username: string;
  page: VoicescapePage;
}) {
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

  useEffect(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) setSupported(false);
    return () => {
      recogRef.current?.abort();
      window.speechSynthesis?.cancel();
    };
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
      if (action.openTip) {
        // ?tip=1 is the page's own deep link for the tip box. When it's
        // already in the URL (box was closed), add a nonce so the page's
        // effect refires and reopens it. Close the voice panel so it never
        // sits over the tip flow.
        const hasTip = new URLSearchParams(window.location.search).get("tip") === "1";
        setOpen(false);
        router.push(hasTip ? `/${username}?tip=1&pvvoice=${Date.now()}` : `/${username}?tip=1`);
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
            username,
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
    [busy, lang, username, runAction, speak],
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

  const chips = suggestionChips(page, lang);

  return (
    <div
      style={{
        position: "fixed",
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 20px)",
        left: 20,
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 10,
        maxWidth: "min(340px, calc(100vw - 40px))",
      }}
    >
      {open && (
        <div
          role="dialog"
          aria-label="Talk to this page"
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
            <span aria-hidden>🎙</span>
            <span style={{ fontWeight: 600, flex: 1 }}>Talk to this page</span>
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
              style={{ background: "none", border: "none", color: "#9aa", fontSize: 16, cursor: "pointer" }}
            >
              ✕
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
            }}
          >
            {listening ? "⏹ Stop listening" : busy ? "…" : "🎙 Tap and speak"}
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
          <p style={{ fontSize: 11, opacity: 0.55, margin: "8px 0 0" }}>
            Answers come from this page&apos;s live blocks. Tips open in your wallet — nothing moves
            on its own.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close page voice" : "Talk to this page"}
        title="Talk to this page"
        style={{
          width: 52,
          height: 52,
          borderRadius: "50%",
          border: "1px solid rgba(255,255,255,0.2)",
          background: listening ? "#ef4444" : "rgba(12, 16, 24, 0.92)",
          color: "#e8e4da",
          fontSize: 22,
          cursor: "pointer",
          boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {listening ? "⏹" : "🎙"}
      </button>
    </div>
  );
}
