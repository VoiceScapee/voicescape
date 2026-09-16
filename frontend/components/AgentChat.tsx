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
import { type VoicescapePage, isValidPage, normalizeBlockForRender } from "@/lib/schema";
import { extractPageDraft, stripPageDraft } from "@/lib/buddy-draft";
import BuddyDraftPreview from "./BuddyDraftPreview";
import PreviewErrorBoundary from "./PreviewErrorBoundary";
import BuddyPayButton from "./BuddyPayButton";
import { BUDDY_PUBLISH_INTENT_KEY, saveBuddyDraft } from "./Onboarding";
import { restoreSession, SESSION_HEADER } from "@/lib/session-message";
import { SESSION_STORAGE_KEY } from "@/lib/session";

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

/**
 * Publish path: save the draft and open the builder straight on its
 * Publish tab (via BUDDY_PUBLISH_INTENT_KEY). The builder's own publish
 * flow does the signing — the widget never duplicates wallet logic.
 */
function publishDraft(page: VoicescapePage) {
  saveBuddyDraft(page);
  try {
    sessionStorage.setItem(BUDDY_PUBLISH_INTENT_KEY, "1");
  } catch {
    /* storage unavailable — builder opens normally */
  }
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
  // Build-paywall state (from the server's machine-readable `build.paywall`
  // field): "anon" = builds need a connected wallet, "unpaid" = signed-in
  // wallet has no 5-HBAR credit yet. null = no paywall on this turn.
  const [paywall, setPaywall] = useState<"anon" | "unpaid" | null>(null);
  // Latest build-credit check (GET /api/agent/chat/build-credit): answers
  // only about the caller's own session wallet.
  const [credit, setCredit] = useState<{
    signedIn: boolean;
    hasCredit: boolean;
  } | null>(null);
  const creditTimer = useRef<number | null>(null);
  // The draft currently being refined ("tweak" flow): echoed to the server
  // as refine_draft so follow-ups revise THIS draft, and validated there.
  const [tweakDraft, setTweakDraft] = useState<VoicescapePage | null>(null);
  // The current FREE visual mock (from the server's machine-readable
  // `build.preview`): rendered in-chat with BuddyDraftPreview. This is a
  // mock with placeholder art — never the paid build, so it gets no
  // "Open in Builder" / "Publish" buttons; those stay on the paid draft.
  const [previewDraft, setPreviewDraft] = useState<VoicescapePage | null>(null);
  // Free previews remaining for this build (null = previews don't apply).
  const [previewsLeft, setPreviewsLeft] = useState<number | null>(null);
  // Explicit "tweak the mock" mode: while on, the current mock is echoed
  // as preview_draft so the next message revises it (preview 2 of 2).
  const [tweakingPreview, setTweakingPreview] = useState(false);
  // Async paid build in flight: the server can't finish a paid build
  // inside one serverless turn, so the "go" reply carries a signed
  // job-start token and the widget drives start -> poll -> deliver via
  // /api/agent/chat/build-job. While set, this renders the live progress
  // bubble below the messages. The 5-HBAR payment is consumed only when a
  // valid draft is delivered — failed builds never charge.
  const [buildJob, setBuildJob] = useState<{
    progress: number;
    note: string;
  } | null>(null);
  const buildJobAbort = useRef<AbortController | null>(null);

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

  // Build-credit status (GET /api/agent/chat/build-credit): answers only
  // about the caller's own session wallet. Called when the paywall shows
  // and polled after the visitor pays (mirror-node discovery lags).
  function stopCreditPoll() {
    if (creditTimer.current != null) {
      window.clearInterval(creditTimer.current);
      creditTimer.current = null;
    }
  }
  async function queryCredit(): Promise<boolean> {
    try {
      const res = await fetch("/api/agent/chat/build-credit", {
        headers: { ...sessionHeader() },
        // The endpoint is read-only but answers about a live payment —
        // never serve it from cache.
        cache: "no-store",
      });
      if (!res.ok) return false;
      const data = (await res.json().catch(() => null)) as {
        signedIn?: boolean;
        hasCredit?: boolean;
      } | null;
      if (data && typeof data.signedIn === "boolean") {
        const found = data.signedIn && !!data.hasCredit;
        setCredit({ signedIn: data.signedIn, hasCredit: found });
        return found;
      }
    } catch {
      /* keep the last known state */
    }
    return false;
  }
  function startCreditPoll() {
    stopCreditPoll();
    setCredit(null);
    let tries = 0;
    const tick = () => {
      tries += 1;
      void queryCredit().then((found) => {
        if (found || tries >= 6) stopCreditPoll();
      });
    };
    tick();
    creditTimer.current = window.setInterval(tick, 20_000);
  }
  useEffect(() => {
    stopCreditPoll();
    // Abandon any in-flight paid build when the widget unmounts. The job
    // itself stays resumable server-side; the payment is untouched until a
    // valid draft is delivered.
    return () => {
      buildJobAbort.current?.abort();
      buildJobAbort.current = null;
    };
  }, []);

  // Drive an async paid build: POST start (idempotent per wallet+username),
  // then poll step until the server delivers a valid draft. Each step call
  // runs one bounded build step server-side; a timed-out step just retries.
  // The payment is consumed server-side only on valid draft delivery.
  async function driveBuildJob(token: string) {
    const abort = new AbortController();
    buildJobAbort.current = abort;
    setBusy(true);
    setPaywall(null);
    stopCreditPoll();
    setPreviewDraft(null);
    setPreviewsLeft(null);
    setTweakingPreview(false);
    setBuildJob({ progress: 0.05, note: "Starting your build…" });
    const call = async (
      payload: Record<string, unknown>
    ): Promise<Record<string, any> | null> => {
      const res = await fetch("/api/agent/chat/build-job", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...sessionHeader(),
        },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`build-job HTTP ${res.status}`);
      return (await res.json().catch(() => null)) as Record<string, any> | null;
    };
    try {
      const started = await call({ action: "start", token });
      const jobId =
        started && typeof started.jobId === "string" ? started.jobId : "";
      if (!started || !jobId) throw new Error("build job did not start");
      if (typeof started.progress === "number") {
        setBuildJob({
          progress: started.progress,
          note:
            typeof started.note === "string"
              ? started.note
              : "Starting your build…",
        });
      }
      // Poll: each call runs one bounded step server-side. Forty rounds at
      // ~3s cadence plus up to 45s per step comfortably covers copy +
      // artwork + finalize.
      for (let i = 0; i < 40; i++) {
        const r = await call({ action: "step", jobId });
        if (!r) throw new Error("build job lost");
        if (r.error) {
          const reason =
            typeof r.reason === "string" && r.reason
              ? r.reason
              : "The build hit a snag — nothing was charged.";
          setBuildJob(null);
          setMsgs((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `⚠️ ${reason} Say "go" again and I'll restart the build.`,
            },
          ]);
          return;
        }
        if (r.done && r.draft && isValidPage(r.draft)) {
          const draft = r.draft as VoicescapePage;
          setBuildJob(null);
          // Same states as a synchronous paid draft: paywall and mocks
          // cleared, tweaks chain onto the newest draft.
          setPaywall(null);
          stopCreditPoll();
          setPreviewDraft(null);
          setPreviewsLeft(null);
          setTweakingPreview(false);
          setTweakDraft((cur) => (cur ? draft : cur));
          // Deliver as prose + the fenced page draft the renderer already
          // understands: inline preview, "Open in Builder", Publish, Tweak.
          setMsgs((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `🎉 Your page is ready — here's your custom build with real AI artwork.\n\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``,
            },
          ]);
          return;
        }
        if (typeof r.progress === "number") {
          setBuildJob({
            progress: Math.min(0.99, r.progress),
            note: typeof r.note === "string" ? r.note : "Building…",
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
      throw new Error("build job timed out");
    } catch {
      if (abort.signal.aborted) return;
      setBuildJob(null);
      setMsgs((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            '⚠️ The build ran long and I lost track of it — nothing was charged. Say "go" again and I\'ll pick it back up.',
        },
      ]);
    } finally {
      if (buildJobAbort.current === abort) buildJobAbort.current = null;
      setBusy(false);
    }
  }

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
          // "Tweak" flow: echo the current draft so the server revises THIS
          // draft. Validated server-side against the page schema.
          refine_draft: tweakDraft ? JSON.stringify(tweakDraft) : undefined,
          // Free-mock revision flow: echo the current mock so the next
          // message revises it (preview 2 of 2). Only in explicit
          // tweak-the-mock mode, so unrelated questions never burn a
          // preview.
          preview_draft:
            tweakingPreview && previewDraft
              ? JSON.stringify(previewDraft)
              : undefined,
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
        // Machine-readable build signal: paywall ("anon" | "unpaid" | null)
        // drives the in-chat payment panel; preview carries the free visual
        // mock. Start polling the credit endpoint so "Payment detected"
        // appears when the on-chain tip lands.
        const b = (
          data as {
            build?: {
              paywall?: string;
              preview?: unknown;
              previewsLeft?: number;
              previewSource?: string | null;
              buildJob?: { token?: unknown };
            };
          } | null
        )?.build;
        const pw = b?.paywall;
        if (pw === "anon" || pw === "unpaid") {
          setPaywall(pw);
          startCreditPoll();
        }
        // Async paid build: the "go" turn returns a signed job-start token
        // instead of a synchronous build. Drive start -> poll -> deliver.
        const jobToken = b?.buildJob?.token;
        if (typeof jobToken === "string" && jobToken) {
          void driveBuildJob(jobToken);
        }
        // A free mock arrived: validate client-side too, then show it in
        // the preview panel — never as a paid draft. Normalize once more
        // client-side (belt and suspenders: the server already normalized,
        // but a malformed mock must never reach the renderer), and the
        // error boundary below contains any residual render throw.
        if (b && isValidPage(b.preview)) {
          const incoming = b.preview as VoicescapePage;
          const safe: VoicescapePage = {
            ...incoming,
            blocks: incoming.blocks
              .map(normalizeBlockForRender)
              .filter(
                (blk): blk is NonNullable<ReturnType<typeof normalizeBlockForRender>> =>
                  blk !== null
              ),
          };
          setPreviewDraft(safe);
          setPreviewsLeft(
            typeof b.previewsLeft === "number" ? b.previewsLeft : null
          );
          // Not user-visible: which server path served the mock (live debugging).
          if (typeof b.previewSource === "string") {
            console.debug(`[buddy] preview served via ${b.previewSource}`);
          }
          setTweakingPreview(false);
        }
      }
      const newDraft = extractPageDraft(reply);
      if (newDraft) {
        // A draft arrived — the paid build is live. Clear the paywall panel
        // and the free mock (superseded), and chain tweaks onto the newest
        // draft.
        setPaywall(null);
        stopCreditPoll();
        setPreviewDraft(null);
        setPreviewsLeft(null);
        setTweakingPreview(false);
        setTweakDraft((cur) => (cur ? newDraft : cur));
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
                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              marginTop: 8,
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => publishDraft(draft)}
                              style={{
                                flex: 1,
                                padding: "10px 12px",
                                borderRadius: 10,
                                border: "1px solid rgba(130, 89, 239, 0.4)",
                                cursor: "pointer",
                                fontWeight: 700,
                                fontSize: 13,
                                color: "#fff",
                                background: "rgba(130, 89, 239, 0.18)",
                              }}
                            >
                              Publish page
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setTweakDraft(draft);
                                inputRef.current?.focus();
                              }}
                              style={{
                                flex: 1,
                                padding: "10px 12px",
                                borderRadius: 10,
                                border: "1px solid rgba(255, 255, 255, 0.18)",
                                cursor: "pointer",
                                fontWeight: 700,
                                fontSize: 13,
                                color: "#fff",
                                background: "rgba(255, 255, 255, 0.07)",
                              }}
                            >
                              ✏️ Tweak
                            </button>
                          </div>
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
            {/* Async paid build in flight: live progress while the widget
                drives start -> poll -> deliver. The payment is consumed only
                when the finished draft is delivered below. */}
            {buildJob && (
              <div
                style={{
                  alignSelf: "flex-start",
                  maxWidth: "92%",
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: "14px 14px 14px 4px",
                  border: "1px solid rgba(130, 89, 239, 0.45)",
                  background: "rgba(130, 89, 239, 0.12)",
                  color: "#fff",
                  fontSize: 13.5,
                }}
                role="status"
                aria-label="Building your page"
              >
                <div style={{ fontWeight: 700, marginBottom: 8 }}>
                  🔨 Building your page…
                </div>
                <div
                  style={{
                    height: 8,
                    borderRadius: 4,
                    background: "rgba(255, 255, 255, 0.12)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round(buildJob.progress * 100)}%`,
                      height: "100%",
                      borderRadius: 4,
                      background:
                        "linear-gradient(118deg, #8259ef, #b45cf0)",
                      transition: "width 0.6s ease",
                    }}
                  />
                </div>
                <div
                  style={{
                    marginTop: 7,
                    fontSize: 12,
                    color: "rgba(232, 234, 240, 0.75)",
                  }}
                >
                  {buildJob.note}
                </div>
              </div>
            )}
          </div>

          {/* Free visual-mock preview (placeholder art — not the paid build).
              The mock renders with BuddyDraftPreview but never gets the
              "Open in Builder" / "Publish" buttons: those stay on the paid
              draft's card. */}
          {previewDraft && (
            <div
              style={{
                padding: "10px 12px",
                borderTop: "1px solid rgba(61, 220, 132, 0.25)",
                background: "rgba(61, 220, 132, 0.06)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                <strong style={{ fontSize: 13 }}>
                  🎨 Preview{" "}
                  <span
                    style={{
                      fontWeight: 400,
                      color: "rgba(232, 234, 240, 0.6)",
                      fontSize: 12,
                    }}
                  >
                    {previewsLeft != null && previewsLeft > 0
                      ? `· ${previewsLeft} free ${
                          previewsLeft === 1 ? "tweak" : "tweaks"
                        } left`
                      : "· free previews used"}
                  </span>
                </strong>
                <button
                  type="button"
                  aria-label="Dismiss preview"
                  onClick={() => {
                    setPreviewDraft(null);
                    setPreviewsLeft(null);
                    setTweakingPreview(false);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "rgba(232, 234, 240, 0.6)",
                    cursor: "pointer",
                    fontSize: 14,
                    padding: 4,
                  }}
                >
                  ✕
                </button>
              </div>
              <PreviewErrorBoundary>
                <BuddyDraftPreview page={previewDraft} />
              </PreviewErrorBoundary>
              {previewsLeft != null && previewsLeft > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setTweakingPreview(true);
                    inputRef.current?.focus();
                  }}
                  style={{
                    marginTop: 8,
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid rgba(255, 255, 255, 0.18)",
                    cursor: "pointer",
                    fontWeight: 700,
                    fontSize: 13,
                    color: "#fff",
                    background: "rgba(255, 255, 255, 0.07)",
                  }}
                >
                  ✏️ Tweak this preview
                </button>
              ) : (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 12.5,
                    color: "rgba(232, 234, 240, 0.75)",
                    lineHeight: 1.5,
                  }}
                >
                  This mock uses placeholder art. Pay 5 HBAR below and
                  I&apos;ll build the real page with custom AI artwork.
                </div>
              )}
            </div>
          )}
          {/* Input */}
          {paywall && (
            <div
              style={{
                padding: "10px 12px",
                borderTop: "1px solid rgba(130, 89, 239, 0.2)",
                background: "rgba(130, 89, 239, 0.08)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                <strong style={{ fontSize: 13 }}>🏗️ Build payment</strong>
                <button
                  type="button"
                  aria-label="Dismiss build payment panel"
                  onClick={() => {
                    setPaywall(null);
                    stopCreditPoll();
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "rgba(232, 234, 240, 0.6)",
                    cursor: "pointer",
                    fontSize: 14,
                    padding: 4,
                  }}
                >
                  ✕
                </button>
              </div>
              {paywall === "anon" ? (
                <div
                  style={{
                    fontSize: 12.5,
                    color: "rgba(232, 234, 240, 0.85)",
                    lineHeight: 1.5,
                  }}
                >
                  A custom blockpage build is 5 HBAR and needs a connected
                  wallet. Connect your wallet (top-right), then tap Check
                  again.
                  <div style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      onClick={() => startCreditPoll()}
                      style={{
                        padding: "9px 14px",
                        borderRadius: 10,
                        border: "1px solid rgba(130, 89, 239, 0.4)",
                        cursor: "pointer",
                        fontWeight: 700,
                        fontSize: 13,
                        color: "#fff",
                        background: "rgba(130, 89, 239, 0.18)",
                      }}
                    >
                      Check again
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <BuddyPayButton onPaid={() => startCreditPoll()} />
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      color: "rgba(232, 234, 240, 0.75)",
                      lineHeight: 1.5,
                    }}
                  >
                    {credit === null
                      ? "Checking payment status…"
                      : !credit.signedIn
                        ? "No wallet signed in yet — sign in to check your credit."
                        : credit.hasCredit
                          ? "✅ Payment detected — say “go” and I'll start building."
                          : "No build credit detected yet — pay above and I'll pick it up automatically."}
                  </div>
                </>
              )}
            </div>
          )}
          {tweakingPreview && previewDraft && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 12px",
                borderTop: "1px solid rgba(61, 220, 132, 0.25)",
                background: "rgba(61, 220, 132, 0.07)",
                fontSize: 12.5,
                color: "rgba(232, 234, 240, 0.9)",
              }}
            >
              <span>🎨 Tweaking your preview — tell me what to change.</span>
              <button
                type="button"
                aria-label="Stop tweaking preview"
                onClick={() => setTweakingPreview(false)}
                style={{
                  background: "none",
                  border: "none",
                  color: "rgba(232, 234, 240, 0.6)",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: 4,
                }}
              >
                ✕
              </button>
            </div>
          )}
          {tweakDraft && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 12px",
                borderTop: "1px solid rgba(130, 89, 239, 0.2)",
                background: "rgba(61, 220, 132, 0.07)",
                fontSize: 12.5,
                color: "rgba(232, 234, 240, 0.9)",
              }}
            >
              <span>
                ✏️ Refining your draft — tell me what to change.{" "}
                <strong>@{tweakDraft.username}</strong>
              </span>
              <button
                type="button"
                aria-label="Stop refining draft"
                onClick={() => setTweakDraft(null)}
                style={{
                  background: "none",
                  border: "none",
                  color: "rgba(232, 234, 240, 0.6)",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: 4,
                }}
              >
                ✕
              </button>
            </div>
          )}
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
              placeholder={
                tweakDraft
                  ? `Tell Buddy what to change on @${tweakDraft.username}…`
                  : tweakingPreview
                    ? "Tell Buddy what to tweak on the preview…"
                    : INPUT_PLACEHOLDER
              }
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
