"use client";

/**
 * VoiceInput — a textarea/input with a microphone button for voice-to-text.
 *
 * Uses the Web Speech API (SpeechRecognition). Works in Chrome, Edge, and
 * Safari (14.1+). Gracefully degrades when unsupported: the mic button is
 * hidden and the field works as a normal text input.
 *
 * Usage:
 *   <VoiceInput value={text} onChange={setText} placeholder="Speak or type..." />
 *   <VoiceInput multiline={false} value={...} onChange={...} />  // single-line input
 */

import { useEffect, useRef, useState } from "react";

interface VoiceInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
}

// Minimal typings for the Web Speech API (not in TS DOM lib by default).
interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
  resultIndex: number;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return (SR as (new () => SpeechRecognitionLike) | undefined) ?? null;
}

export function VoiceInput({
  value,
  onChange,
  placeholder,
  multiline = true,
  rows = 3,
  className,
  style,
  ariaLabel,
}: VoiceInputProps) {
  const [supported] = useState(() => getSpeechRecognition() !== null);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const baseTextRef = useRef("");

  // Clean up recognition on unmount.
  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        /* noop */
      }
    };
  }, []);

  function toggleListening() {
    if (listening) {
      try {
        recognitionRef.current?.stop();
      } catch {
        /* noop */
      }
      return;
    }
    const SR = getSpeechRecognition();
    if (!SR) {
      setVoiceError("Voice input isn't supported in this browser. Try Chrome or Edge.");
      return;
    }
    setVoiceError(null);
    const rec = new SR();
    recognitionRef.current = rec;
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    baseTextRef.current = value;

    rec.onresult = (e: SpeechRecognitionEventLike) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i][0]?.transcript ?? "";
        if ((e.results[i] as unknown as { isFinal?: boolean }).isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }
      const base = baseTextRef.current;
      const sep = base && !base.endsWith(" ") ? " " : "";
      onChange(base + sep + final + interim);
    };
    rec.onerror = (e: { error: string }) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setVoiceError("Microphone access was blocked. Allow it in your browser settings and try again.");
      } else if (e.error === "no-speech") {
        setVoiceError("Didn't hear anything — try again.");
      } else if (e.error !== "aborted") {
        setVoiceError(`Voice input error: ${e.error}`);
      }
      setListening(false);
    };
    rec.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    try {
      rec.start();
      setListening(true);
    } catch {
      setVoiceError("Couldn't start voice input. Try again.");
      setListening(false);
    }
  }

  const fieldStyle: React.CSSProperties = {
    ...style,
    paddingRight: supported ? 40 : undefined,
  };

  const micButton = supported ? (
    <button
      type="button"
      onClick={toggleListening}
      title={listening ? "Stop listening" : "Dictate with your voice"}
      aria-label={listening ? "Stop voice input" : "Start voice input"}
      style={{
        position: "absolute",
        right: 6,
        top: multiline ? 8 : "50%",
        transform: multiline ? "none" : "translateY(-50%)",
        width: 30,
        height: 30,
        borderRadius: "50%",
        border: listening ? "2px solid #f87171" : "1px solid var(--vs-border)",
        background: listening ? "rgba(248,113,113,0.15)" : "var(--vs-glass)",
        color: listening ? "#f87171" : "var(--vs-cyan)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 15,
        flexShrink: 0,
      }}
    >
      {listening ? (
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: "#f87171",
            animation: "vsPulseGlow 1s ease-in-out infinite",
          }}
        />
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10a7 7 0 0 0 14 0" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </svg>
      )}
    </button>
  ) : null;

  return (
    <div style={{ position: "relative", width: "100%" }}>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          className={className}
          style={fieldStyle}
          aria-label={ariaLabel ?? placeholder}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={className}
          style={fieldStyle}
          aria-label={ariaLabel ?? placeholder}
        />
      )}
      {micButton}
      {voiceError && (
        <div style={{ color: "#f87171", fontSize: 12, marginTop: 4 }}>{voiceError}</div>
      )}
      {listening && (
        <div style={{ color: "var(--vs-cyan)", fontSize: 12, marginTop: 4 }}>
          Listening… speak now.
        </div>
      )}
    </div>
  );
}
