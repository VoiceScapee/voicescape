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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BUDDY_CELEBRATE_KEY } from "./OnboardingTrigger";
import { type VoicescapePage } from "@/lib/schema";
import { extractPageDraft, stripPageDraft } from "@/lib/buddy-draft";
import BuddyDraftPreview from "./BuddyDraftPreview";
import { saveBuddyDraft } from "./Onboarding";
import { restoreSession, SESSION_HEADER } from "@/lib/session-message";
import { SESSION_STORAGE_KEY } from "@/lib/session";
import { TIP_PANEL_EVENT } from "@/lib/tip-currency";

/** Floating Buddy button: draggable so it never has to sit on top of
 *  content. Position (viewport left/top px) persists across visits. */
const FAB_SIZE = 56;
const FAB_DEFAULT_GAP = 18;
const FAB_POS_KEY = "vs-buddy-fab-pos";

type FabPos = { x: number; y: number };

function readFabPos(): FabPos | null {
  try {
    const raw = window.localStorage.getItem(FAB_POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<FabPos>;
    if (typeof p.x === "number" && typeof p.y === "number") return { x: p.x, y: p.y };
  } catch {
    /* storage unavailable — fall back to the default corner */
  }
  return null;
}

function clampFabPos(x: number, y: number): FabPos {
  const maxX = Math.max(8, window.innerWidth - FAB_SIZE - 8);
  const maxY = Math.max(8, window.innerHeight - FAB_SIZE - 8);
  return {
    x: Math.min(Math.max(x, 8), maxX),
    y: Math.min(Math.max(y, 8), maxY),
  };
}

type Msg = { role: "user" | "assistant"; content: string };

const GREETING: Msg = {
  role: "assistant",
  content:
    "Hey, welcome to Voicescape! 👋 I'm Buddy. A blockpage is your own little corner of the internet — you own it, not us. Your wallet is your login (no passwords), and anything of value moves on-chain where you can verify it. Want the quick tour, or ready to build your page? If you build with me, just give me a username, a short bio, and the vibe — I'll make the artwork and the whole page for you.",
};

/** Assistant replies, rendered as styled markdown for a narrow chat bubble. */
function BuddyMarkdown({ content }: { content: string }) {
  return (
    <div className="buddy-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ node, ...props }) => <p style={{ margin: "0 0 8px" }} {...props} />,
          h1: ({ node, ...props }) => <h1 style={{ margin: "10px 0 6px", fontSize: 15 }} {...props} />,
          h2: ({ node, ...props }) => <h2 style={{ margin: "10px 0 6px", fontSize: 14.5 }} {...props} />,
          h3: ({ node, ...props }) => <h3 style={{ margin: "10px 0 6px", fontSize: 14 }} {...props} />,
          h4: ({ node, ...props }) => <h4 style={{ margin: "10px 0 6px", fontSize: 13.5 }} {...props} />,
          ul: ({ node, ...props }) => <ul style={{ margin: "0 0 8px", paddingLeft: 18 }} {...props} />,
          ol: ({ node, ...props }) => <ol style={{ margin: "0 0 8px", paddingLeft: 18 }} {...props} />,
          li: ({ node, ...props }) => <li style={{ margin: "2px 0" }} {...props} />,
          a: ({ node, ...props }) => (
            <a style={{ color: "#c4b5fd", textDecoration: "underline" }} target="_blank" rel="noreferrer" {...props} />
          ),
          code: ({ node, ...props }) => (
            <code
              style={{
                background: "rgba(255,255,255,0.12)",
                padding: "1px 5px",
                borderRadius: 5,
                fontSize: 12.5,
                fontFamily: "ui-monospace, monospace",
              }}
              {...props}
            />
          ),
          pre: ({ node, ...props }) => (
            <pre
              style={{
                background: "rgba(0,0,0,0.35)",
                padding: 10,
                borderRadius: 10,
                overflowX: "auto",
                fontSize: 12.5,
                margin: "0 0 8px",
              }}
              {...props}
            />
          ),
          blockquote: ({ node, ...props }) => (
            <blockquote
              style={{ borderLeft: "3px solid rgba(167,139,250,0.5)", paddingLeft: 10, margin: "0 0 8px", opacity: 0.92 }}
              {...props}
            />
          ),
          hr: ({ node, ...props }) => <hr style={{ borderColor: "rgba(255,255,255,0.15)", margin: "10px 0" }} {...props} />,
          table: ({ node, ...props }) => (
            <table style={{ width: "100%", borderCollapse: "collapse", margin: "0 0 8px", fontSize: 12.5 }} {...props} />
          ),
          th: ({ node, ...props }) => (
            <th style={{ border: "1px solid rgba(255,255,255,0.14)", padding: "4px 8px", textAlign: "left" }} {...props} />
          ),
          td: ({ node, ...props }) => (
            <td style={{ border: "1px solid rgba(255,255,255,0.14)", padding: "4px 8px" }} {...props} />
          ),
          img: ({ node, ...props }) => <img style={{ maxWidth: "100%", borderRadius: 8 }} {...props} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** One-tap handoff: save the Buddy-built page and open the builder with it. */
function openInBuilder(page: VoicescapePage) {
  saveBuddyDraft(page);
  window.location.href = "/builder";
}

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

/**
 * The wallet session header, when the visitor is signed in. This widget
 * mounts outside SessionProvider, so it reads the persisted session
 * directly (same storage the provider uses). Lets the server enforce the
 * 5-HBAR build entitlement on build turns; anonymous visitors simply send
 * no header and are stopped at the paywall when a build starts.
 */
function sessionHeader(): Record<string, string> {
  try {
    const { session } = restoreSession(
      window.localStorage.getItem(SESSION_STORAGE_KEY)
    );
    if (session?.token) return { [SESSION_HEADER]: session.token };
  } catch {
    /* storage unavailable — anonymous */
  }
  return {};
}

export default function AgentChat() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Server-signed build-progress token (opaque): echoed back each turn so
  // Buddy can track the multi-turn blockpage flow. Never displayed.
  const buildStateRef = useRef<string>("");
  // Free off-topic messages remaining (null = unknown / not metered).
  // Voicescape & blockchain questions are always free and never count.
  const [freeLeft, setFreeLeft] = useState<number | null>(null);
  // Draggable floating-button position (null = default bottom-right corner).
  const [fabPos, setFabPos] = useState<FabPos | null>(() =>
    typeof window !== "undefined" ? readFabPos() : null,
  );
  // A tip panel is open somewhere — hide the button so it can't cover it.
  const [tipOpen, setTipOpen] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
    pos: FabPos | null;
  } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const onTip = (e: Event) => setTipOpen((e as CustomEvent<boolean>).detail === true);
    window.addEventListener(TIP_PANEL_EVENT, onTip);
    return () => window.removeEventListener(TIP_PANEL_EVENT, onTip);
  }, []);

  // Keep a saved position on-screen across rotation/resize.
  useEffect(() => {
    const onResize = () => setFabPos((p) => (p ? clampFabPos(p.x, p.y) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onFabPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.left,
      origY: rect.top,
      moved: false,
      pos: null,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* older browsers — dragging still works without capture */
    }
  };

  const onFabPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.hypot(dx, dy) > 8) d.moved = true;
    if (d.moved) {
      const pos = clampFabPos(d.origX + dx, d.origY + dy);
      d.pos = pos;
      setFabPos(pos);
    }
  };

  const onFabPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.moved) {
      // It was a drag, not a tap: don't toggle the chat, and remember
      // where the visitor dropped the button.
      suppressClickRef.current = true;
      if (d.pos) {
        try {
          window.localStorage.setItem(FAB_POS_KEY, JSON.stringify(d.pos));
        } catch {
          /* storage unavailable — position still holds for this visit */
        }
      }
    }
  };

  const onFabClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setOpen((v) => !v);
  };

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
        headers: {
          "content-type": "application/json",
          ...sessionHeader(),
        },
        body: JSON.stringify({
          message: text,
          history,
          build_state: buildStateRef.current || undefined,
        }),
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
        // Keep the signed build token for the next turn (opaque string).
        if (data && typeof data.build_state === "string") {
          buildStateRef.current = data.build_state;
        }
        // Free-message countdown for off-topic chat (on-topic Q&A is free
        // and never counts). The paywall reply clears it to zero.
        const chat = data?.chat as
          | { metered?: boolean; kind?: string; left?: number }
          | undefined;
        if (chat?.metered && typeof chat.left === "number") {
          setFreeLeft(chat.kind === "free" ? Math.max(0, chat.left) : null);
        } else if (chat?.metered) {
          setFreeLeft(0);
        }
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
      {/* Floating button: draggable, and hidden while the chat or a tip
          panel is open (both have their own close affordance). */}
      {!open && !tipOpen && (
        <button
          type="button"
          aria-label="Open Blockpage Buddy chat"
          onClick={onFabClick}
          onPointerDown={onFabPointerDown}
          onPointerMove={onFabPointerMove}
          onPointerUp={onFabPointerUp}
          onPointerCancel={onFabPointerUp}
          style={{
            position: "fixed",
            ...(fabPos
              ? { left: fabPos.x, top: fabPos.y }
              : { right: FAB_DEFAULT_GAP, bottom: FAB_DEFAULT_GAP }),
            zIndex: 60,
            width: FAB_SIZE,
            height: FAB_SIZE,
            borderRadius: "50%",
            border: "none",
            cursor: "grab",
            fontSize: 24,
            color: "#fff",
            background: "linear-gradient(118deg, #8259ef 0%, #4f46e5 44%, #0031ff 100%)",
            boxShadow: "0 8px 28px rgba(80, 60, 220, 0.45)",
            touchAction: "none",
          }}
        >
          🔨
        </button>
      )}

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
            <button
              type="button"
              aria-label="Close Blockpage Buddy chat"
              onClick={() => setOpen(false)}
              style={{
                marginLeft: "auto",
                flex: "none",
                width: 30,
                height: 30,
                borderRadius: "50%",
                border: "1px solid rgba(255, 255, 255, 0.14)",
                background: "transparent",
                color: "rgba(232, 234, 240, 0.75)",
                fontSize: 14,
                cursor: "pointer",
                lineHeight: 1,
              }}
            >
              ✕
            </button>
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
            {msgs.map((m, i) => {
              const draft = m.role === "assistant" ? extractPageDraft(m.content) : null;
              // The raw page JSON is machine handoff, not reading material —
              // hide it and show the inline preview plus the one-tap builder
              // button ("tweak it" path) instead.
              const visible = draft != null ? stripPageDraft(m.content) : m.content;
              return (
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
                    wordBreak: "break-word",
                    background:
                      m.role === "user"
                        ? "rgba(130, 89, 239, 0.22)"
                        : "rgba(255, 255, 255, 0.055)",
                    color: "#fff",
                  }}
                >
                  {m.role === "assistant" ? (
                    <>
                      <BuddyMarkdown content={visible} />
                      {draft != null && (
                        <>
                          <BuddyDraftPreview page={draft} />
                          <button
                            type="button"
                            onClick={() => openInBuilder(draft)}
                            style={{
                              marginTop: 8,
                              width: "100%",
                              padding: "10px 12px",
                              borderRadius: 10,
                              border: "none",
                              cursor: "pointer",
                              fontWeight: 700,
                              fontSize: 14,
                              color: "#fff",
                              background: "linear-gradient(135deg, #8259ef, #b45cf0)",
                            }}
                          >
                            Open in Builder →
                          </button>
                        </>
                      )}
                    </>
                  ) : (
                    <span style={{ whiteSpace: "pre-wrap" }}>{m.content}</span>
                  )}
                </div>
              );
            })}
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
          {freeLeft !== null && freeLeft > 0 && (
            <div
              style={{
                padding: "6px 12px 0",
                fontSize: 11,
                color: "rgba(232, 234, 240, 0.55)",
              }}
            >
              {freeLeft} free {freeLeft === 1 ? "message" : "messages"} left —{" "}
              Voicescape &amp; blockchain questions are always free
            </div>
          )}
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
.agent-chat-dots { animation: agentChatBlink 1.2s infinite; letter-spacing: 2px; }
.buddy-md > *:last-child { margin-bottom: 0 !important; }
.buddy-md pre code { background: transparent !important; padding: 0 !important; }`}</style>
    </>
  );
}
