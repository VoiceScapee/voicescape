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

type Msg = { role: "user" | "assistant"; content: string };

const GREETING: Msg = {
  role: "assistant",
  content:
    "Hey! I can look up blockpages, check tips, and answer questions about Voicescape — all from live chain data.",
};

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
        {open ? "✕" : "💬"}
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
            borderRadius: 16,
            overflow: "hidden",
            background: "#0d1119",
            border: "1px solid rgba(130, 89, 239, 0.35)",
            boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
            color: "#e8eaf0",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "12px 14px",
              background: "linear-gradient(118deg, #8259ef 0%, #4f46e5 44%, #0031ff 100%)",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 15 }}>Blockpage Buddy</div>
            <div style={{ fontSize: 11, opacity: 0.85 }}>beta · read-only</div>
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
                  padding: "8px 12px",
                  borderRadius: 12,
                  fontSize: 14,
                  lineHeight: 1.45,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  background:
                    m.role === "user"
                      ? "linear-gradient(118deg, #8259ef 0%, #4f46e5 100%)"
                      : "rgba(130, 89, 239, 0.12)",
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
                  padding: "8px 12px",
                  borderRadius: 12,
                  background: "rgba(130, 89, 239, 0.12)",
                  color: "#fff",
                  fontSize: 14,
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
              placeholder="Ask about blockpages, tips…"
              aria-label="Message Blockpage Buddy"
              maxLength={2000}
              style={{
                flex: 1,
                borderRadius: 10,
                border: "1px solid rgba(130, 89, 239, 0.3)",
                background: "#090b12",
                color: "#fff",
                padding: "10px 12px",
                fontSize: 14,
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
