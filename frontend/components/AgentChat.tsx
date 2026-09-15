/**
 * AgentChat — floating onboarding-buddy chat widget.
 *
 * Mounted in the root layout so it appears on every page. Talks to
 * POST /api/agent/chat. Degrades gracefully when the backend is unavailable
 * (503) or rate-limited (429). Read-only: the buddy can look things up but
 * never signs, spends, or publishes.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { BUDDY_CELEBRATE_KEY } from "./OnboardingTrigger";

type Msg = { role: "user" | "assistant"; content: string };

const GREETING: Msg = {
  role: "assistant",
  content:
    "Hey, I'm Buddy. I can look up any blockpage, check whether a tip landed, or show you how the treasury's doing. What's up?",
};

/** One-time greeting after the visitor publishes their blockpage. */
function celebrationMsg(username: string | null): Msg {
  return {
    role: "assistant",
    content:
      "🎉 Your blockpage is live!" +
      (username
        ? ` Take a bow — it's up at /${username}. What's next: share it, or keep polishing?`
        : " Take a bow. What's next: share it, or keep polishing?"),
  };
}

/** Header tagline + input placeholder: hard-coded on purpose — this widget
 *  mounts outside LanguageProvider, so useLanguage() is unavailable here. */
const HEADER_TAGLINE = "Ask me anything — I check the chain";
const INPUT_PLACEHOLDER = "Ask Buddy…";

const UNAVAILABLE = "Chat is unavailable right now — try again later.";
const RATE_LIMITED = "Slow down a little — try again in a bit.";
const FAILED = "Something went wrong — mind trying again?";

export default function AgentChat() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, busy, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open ]);

  // One-time "🎉 Your blockpage is live!" greeting after a publish.
  // The builder sets BUDDY_CELEBRATE_KEY via markPublished(); we consume
  // and clear it here so it shows exactly once.
  useEffect(() => {
    try {
      if (localStorage.getItem(BUDDY_CELEBRATE_KEY) === "true") {
        localStorage.removeItem(BUDDY_CELEBRATE_KEY);
        const username = localStorage.getItem("vs_published_username");
        setMsgs([celebrationMsg(username)]);
      }
    } catch {
      /* storage unavailable — keep the default greeting */
    }
  }, []);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const next = [...msgs, { role: "user", content: text } as Msg];
    setMsgs(next);
    setBusy(true);
    try {
      const history = next
        .filter((m) => m !== GREETING)
        .slice(-6)
        .map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, history }),
      });
      let reply: string;
      if (res.status === 503) reply = UNAVAILABLE;
      else if (res.status === 429) reply = RATE_LIMITED;
      else if (!res.ok) reply = FAILED;
      else {
        const data = await res.json().catch(() => null);
        reply =
          data && typeof data.reply === "string" && data.reply
            ? data.reply
            : FAILED;
      }
      setMsgs((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch {
      setMsgs((prev) => [...prev, { role: "assistant", content: FAILED }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Floating button */}
      <button
        type="button"
        aria-label={open ? "Close Blockpage Buddy chat" : "Open Blockpage Buddy chat"}
        onClick={() => setOpen((v) => !v)}
        style={{
          position: "fixed",
          right: 18,
          bottom: 18,
          zIndex: 60,
          width: 56,
          height: 56,
          borderRadius: "50%",
          border: "none",
          cursor: "pointer",
          fontSize: 24,
          color: "#fff",
          background: "linear-gradient(118deg, #8259ef 0%, #4f46e5 44%, #0031ff 100%)",
          boxShadow: "0 8px 28px rgba(80, 60, 220, 0.45)",
        }}
      >
        🔨
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Blockpage Buddy chat"
          style={{
            position: "fixed",
            zIndex: 60,
            right: 12,
            bottom: 86,
            width: "min(380px, calc(100vw - 24px))",
            height: "min(520px, calc(100dvh - 120px))",
            display: "flex",
            flexDirection: "column",
            borderRadius: 20,
            overflow: "hidden",
            background: "linear-gradient(160deg, #181d2a, #12151f)",
            border: "1px solid rgba(255, 255, 255, 0.09)",
            boxShadow: "0 24px 70px rgba(0, 0, 0, 0.42)",
            color: "#e8eaf0",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "13px 15px",
              borderBottom: "1px solid rgba(255, 255, 255, 0.09)",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: "#3ddc84",
                boxShadow: "0 0 8px #3ddc84",
                flex: "none",
              }}
            />
            <div>
              {/* Buddy's blockpage: the one-time claim congrats card lives
                  here — without this link nothing in the app points at
                  /forge, so the card would be undiscoverable. */}
              <a
                href="/forge"
                title="Visit Blockpage Buddy's blockpage"
                style={{
                  fontWeight: 700,
                  fontSize: 14,
                  color: "inherit",
                  textDecoration: "none",
                }}
              >
                🔨 Blockpage Buddy
              </a>
              <div style={{ fontSize: 11.5, color: "rgba(232, 234, 240, 0.6)" }}>{HEADER_TAGLINE}</div>
            </div>
          </div>

          {/* Messages */}
          <div
            ref={listRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "12px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {msgs.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "85%",
                  padding: "10px 12px",
                  borderRadius: m.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                  border: "1px solid",
                  borderColor:
                    m.role === "user"
                      ? "rgba(130, 89, 239, 0.4)"
                      : "rgba(255, 255, 255, 0.09)",
                  fontSize: 13.5,
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  background:
                    m.role === "user"
                      ? "rgba(130, 89, 239, 0.22)"
                      : "rgba(255, 255, 255, 0.055)",
                  color: "#fff",
                }}
              >
                {m.content}
              </div>
            ))}
            {busy && (
              <div
                style={{
                  alignSelf: "flex-start",
                  padding: "10px 12px",
                  borderRadius: "14px 14px 14px 4px",
                  border: "1px solid rgba(255, 255, 255, 0.09)",
                  background: "rgba(255, 255, 255, 0.055)",
                  color: "#fff",
                  fontSize: 13.5,
                }}
                aria-label="Buddy is thinking"
              >
                <span className="agent-chat-dots">● ● ●</span>
              </div>
            )}
          </div>

          {/* Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            style={{
              display: "flex",
              gap: 8,
              padding: 10,
              borderTop: "1px solid rgba(130, 89, 239, 0.2)",
            }}
          >
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={INPUT_PLACEHOLDER}
              aria-label="Message Blockpage Buddy"
              maxLength={2000}
              style={{
                flex: 1,
                borderRadius: 12,
                border: "1px solid rgba(255, 255, 255, 0.09)",
                background: "#0d111a",
                color: "#fff",
                padding: "10px 12px",
                fontSize: 13.5,
                outline: "none",
              }}
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              aria-label="Send message"
              style={{
                borderRadius: 10,
                border: "none",
                cursor: "pointer",
                padding: "0 16px",
                fontSize: 14,
                fontWeight: 700,
                color: "#fff",
                background: "linear-gradient(118deg, #8259ef 0%, #4f46e5 44%, #0031ff 100%)",
                opacity: busy || !input.trim() ? 0.5 : 1,
              }}
            >
              Send
            </button>
          </form>
        </div>
      )}

      <style>{`@keyframes agentChatBlink { 0%,100% { opacity: 0.25; } 50% { opacity: 1; } }
.agent-chat-dots { animation: agentChatBlink 1.2s infinite; letter-spacing: 2px; }`}</style>
    </>
  );
}
