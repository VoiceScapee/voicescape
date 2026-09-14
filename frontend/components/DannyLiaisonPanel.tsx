"use client";

/**
 * DannyLiaisonPanel — the paid human-facing helper on danny's blockpage.
 *
 * Humans connect their wallet, sign in, and can:
 * - buy chat: 5 HBAR → 50 messages with Danny,
 * - buy a build: 5 HBAR → 1 premade blockpage draft, bound to their wallet.
 * No bundle, no free tier — each product is bought separately. Prices are
 * env-tunable (LIAISON_CHAT_PRICE_HBAR / LIAISON_BUILD_PRICE_HBAR) and the
 * server refuses to serve below the floor (never loses money).
 *
 * The regular builder stays free for anyone who builds themselves — the
 * paywall applies ONLY to this panel and its /api/liaison routes.
 *
 * Non-custody: Danny can never publish for the user, sign for the user, or
 * touch a published page. Publishing is always the user's own wallet
 * signature in the builder.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "@/lib/wallet";
import { useSession } from "@/lib/session";
import { useConfirmedTransaction } from "@/hooks/useConfirmedTransaction";
import { tipPage } from "@/lib/contracts";
import { TEMPLATES } from "@/lib/templates";
import { friendlyWalletError } from "@/lib/wallet";

interface LiaisonStatus {
  chatPriceHbar: number;
  buildPriceHbar: number;
  chatPerPayment: number;
  buildsPerPayment: number;
  chatLeft: number;
  buildsLeft: number;
  expMs: number | null;
  celebratedUsername?: string | null;
}

type LiaisonProduct = "chat" | "build";

interface ChatMsg {
  role: "user" | "danny";
  text: string;
}

const HUMAN_TEMPLATES = TEMPLATES.filter((t) => t.page.ownerType !== "agent");

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--vs-border, #2a2a35)",
  borderRadius: 14,
  padding: "16px 16px 12px",
  margin: "4px 0 20px",
  background: "var(--vs-card, rgba(255,255,255,0.02))",
};

const btnStyle: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: 10,
  border: "none",
  background: "var(--vs-accent, #38bdf8)",
  color: "#0b0f16",
  fontWeight: 700,
  fontSize: "0.95rem",
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid var(--vs-border)",
  background: "var(--vs-glass)",
  color: "var(--vs-text)",
  fontSize: 14,
};

export default function DannyLiaisonPanel() {
  const { account, connect, getTxSender } = useWallet();
  const { isAuthenticated, authHeader } = useSession();
  const [status, setStatus] = useState<LiaisonStatus | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pay flow
  const [paying, setPaying] = useState<LiaisonProduct | null>(null);
  const [payStage, setPayStage] = useState<"wallet" | "confirming" | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [confirmTxId, setConfirmTxId] = useState<string | null>(null);
  const [confirmProduct, setConfirmProduct] = useState<LiaisonProduct | null>(null);
  const confirmStatus = useConfirmedTransaction(confirmTxId);

  // Build interview — conversational flow that replaces the rigid form.
  // After paying for a build, Danny interviews the user in the chat:
  // page type → vibe/business type → name → tagline → bio → username →
  // review → draft. No chat credits consumed; the build was already paid.
  type InterviewStep =
    | "pageType"
    | "vibe"
    | "bizType"
    | "displayName"
    | "heroTitle"
    | "bio"
    | "usernameHint"
    | "review";
  interface InterviewState {
    step: InterviewStep;
    pageType?: "personal" | "business";
    vibe?: string;
    bizType?: string;
    displayName?: string;
    heroTitle?: string;
    bio?: string;
    usernameHint?: string;
  }
  const [interview, setInterview] = useState<InterviewState | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildDone, setBuildDone] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  const authedFetch = useCallback(
    (path: string, init?: RequestInit) =>
      fetch(path, { ...init, headers: { ...authHeader(), ...(init?.headers ?? {}) } }),
    [authHeader],
  );

  const refreshStatus = useCallback(async () => {
    try {
      const res = await authedFetch("/api/liaison/status", { cache: "no-store" });
      if (res.ok) {
        const s = (await res.json()) as LiaisonStatus;
        setStatus(s);
        // One-time congratulations: the user published a Danny-built page.
        // The server clears the flag on read, so this shows exactly once.
        if (s.celebratedUsername) {
          setMessages((m) => [
            ...m,
            {
              role: "danny",
              text: `🎉 Your page @${s.celebratedUsername} is live! I loved building that with you. It's all yours now — share it, tip it, make it yours.`,
            },
          ]);
        }
      }
    } catch {
      /* panel stays usable without status */
    }
  }, [authedFetch]);

  useEffect(() => {
    if (isAuthenticated) refreshStatus();
    else setStatus(null);
  }, [isAuthenticated, refreshStatus]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);

  // Tip approved → confirmed on-chain → verify with the server for the
  // product that was bought.
  useEffect(() => {
    if (!confirmTxId) return;
    if (confirmStatus === "confirmed") {
      authedFetch("/api/liaison/verify-tip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash: confirmTxId, product: confirmProduct ?? "chat" }),
      })
        .then(async (r) => {
          const j = await r.json().catch(() => null);
          if (r.ok) {
            setPayError(null);
            await refreshStatus();
          } else {
            setPayError(
              typeof j?.error === "string" ? j.error : "Couldn't unlock your purchase — try again.",
            );
          }
        })
        .catch(() => setPayError("Couldn't unlock your purchase — try again."))
        .finally(() => {
          setPaying(null);
          setPayStage(null);
          setConfirmTxId(null);
          setConfirmProduct(null);
        });
    } else if (confirmStatus === "failed") {
      setPayError("The tip transaction failed on-chain — no payment was sent.");
      setPaying(null);
      setPayStage(null);
      setConfirmTxId(null);
      setConfirmProduct(null);
    } else if (confirmStatus === "timeout") {
      setPayError("Tip submitted but not yet visible — give it a moment, then refresh.");
      setPaying(null);
      setPayStage(null);
      setConfirmTxId(null);
      setConfirmProduct(null);
    }
  }, [confirmStatus, confirmTxId, confirmProduct, authedFetch, refreshStatus]);

  const sendChat = async () => {
    const text = input.trim();
    if (!text || busy) return;
    // Interview mode: answers are handled locally — no chat credit spent,
    // the build was already paid for.
    if (interview) {
      setInput("");
      answerInterview(text);
      return;
    }
    setError(null);
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text }]);
    setInput("");
    try {
      const res = await authedFetch("/api/liaison/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const j = (await res.json().catch(() => null)) as {
        answer?: string;
        chatLeft?: number;
        buildsLeft?: number;
        error?: string;
      } | null;
      if (!res.ok || !j?.answer) {
        throw new Error(
          typeof j?.error === "string" ? j.error : "Couldn't reach Danny right now.",
        );
      }
      setMessages((m) => [...m, { role: "danny", text: j.answer as string }]);
      setStatus((s) =>
        s
          ? {
              ...s,
              chatLeft: j.chatLeft ?? s.chatLeft,
              buildsLeft: j.buildsLeft ?? s.buildsLeft,
            }
          : s,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach Danny right now.");
    } finally {
      setBusy(false);
    }
  };

  const pay = async (product: LiaisonProduct) => {
    setPayError(null);
    if (!account) {
      setPayError("Connect a wallet first.");
      return;
    }
    const price =
      product === "chat" ? (status?.chatPriceHbar ?? 5) : (status?.buildPriceHbar ?? 5);
    setPaying(product);
    setPayStage("wallet");
    try {
      const sender = await getTxSender();
      // tipPage takes an 18-decimal valueWei. HBAR on the EVM side of
      // Hedera is 10^18 wei per HBAR (same as ethers' ether units) —
      // parseUnits from the price string keeps non-integer prices exact.
      const wei = ethers.parseUnits(price.toString(), 18);
      setPayStage("confirming");
      const hash = await tipPage("danny", wei, sender);
      // Approved — wait for real on-chain confirmation before unlocking.
      setConfirmProduct(product);
      setConfirmTxId(hash);
    } catch (e) {
      setPayError(`Tip failed: ${friendlyWalletError(e)}`);
      setPaying(null);
      setPayStage(null);
    }
  };

  const buyButton = (product: LiaisonProduct, label: string) => (
    <button
      type="button"
      onClick={() => pay(product)}
      disabled={paying !== null}
      style={{ ...btnStyle, padding: "8px 14px", fontSize: "0.85rem" }}
    >
      {paying === product
        ? payStage === "wallet"
          ? "Waiting for wallet…"
          : "Confirming on-chain…"
        : label}
    </button>
  );

  // Interview → template mapping. Vibe/business-type answers pick the
  // starting template; the user customizes everything in the builder after.
  const INTERVIEW_TEMPLATES: Record<string, string> = {
    "personal:dark": "lofi-room",
    "personal:bright": "solarpunk-garden",
    "personal:bold": "aurora-drift",
    "personal:clean": "wanderer-atlas",
    "business:general": "business-card",
    "business:food": "restaurant",
    "business:shop": "retail-shop",
    "business:services": "salon",
  };

  const VIBE_LABELS: Record<string, string> = {
    dark: "dark & chill",
    bright: "bright & playful",
    bold: "bold & colorful",
    clean: "clean & minimal",
  };

  const BIZ_LABELS: Record<string, string> = {
    general: "general / professional",
    food: "food & drink",
    shop: "shop / retail",
    services: "services",
  };

  const dannySay = (text: string) =>
    setMessages((m) => [...m, { role: "danny", text }]);
  const userSay = (text: string) =>
    setMessages((m) => [...m, { role: "user", text }]);

  const startInterview = () => {
    if (status != null && status.buildsLeft <= 0) return;
    setError(null);
    setInterview({ step: "pageType" });
    dannySay(
      "Let's build your page! First — is this a personal page, or for a business?",
    );
  };

  const cancelInterview = () => {
    setInterview(null);
    setInput("");
    dannySay("No worries — we can build whenever you're ready. Just tap “✨ Build me a blockpage”.");
  };

  /** Advance the interview one step. Returns true when the answer was consumed. */
  const answerInterview = (raw: string): boolean => {
    if (!interview) return false;
    const text = raw.trim();
    if (!text) return false;
    const iv = interview;

    if (iv.step === "pageType") {
      const t = text.toLowerCase();
      const pageType = t.includes("business") ? "business" : t.includes("personal") ? "personal" : null;
      if (!pageType) {
        dannySay("Pick one — is it a personal page or for a business?");
        return true;
      }
      userSay(pageType === "personal" ? "Personal" : "Business");
      if (pageType === "personal") {
        setInterview({ ...iv, step: "vibe", pageType });
        dannySay("Nice. What vibe should it have?");
      } else {
        setInterview({ ...iv, step: "bizType", pageType });
        dannySay("Got it. What kind of business?");
      }
      return true;
    }

    if (iv.step === "vibe") {
      const t = text.toLowerCase();
      const vibe = (["dark", "bright", "bold", "clean"] as const).find((v) =>
        t.includes(v),
      );
      if (!vibe) {
        dannySay("Choose a vibe — dark, bright, bold, or clean?");
        return true;
      }
      userSay(VIBE_LABELS[vibe]);
      setInterview({ ...iv, step: "displayName", vibe });
      dannySay("Love it. What's your name for the big hero title?");
      return true;
    }

    if (iv.step === "bizType") {
      const t = text.toLowerCase();
      const bizType = (["food", "shop", "services", "general"] as const).find((b) =>
        t.includes(b),
      );
      if (!bizType) {
        dannySay("What kind of business — general, food & drink, shop, or services?");
        return true;
      }
      userSay(BIZ_LABELS[bizType]);
      setInterview({ ...iv, step: "displayName", bizType });
      dannySay("Perfect. What's the business name for the big hero title?");
      return true;
    }

    if (iv.step === "displayName") {
      if (text.length > 60) {
        dannySay("A bit long — keep the name under 60 characters?");
        return true;
      }
      userSay(text);
      setInterview({ ...iv, step: "heroTitle", displayName: text });
      dannySay("Got a tagline? (e.g. “Web3 builder & creator”) — or type “skip”.");
      return true;
    }

    if (iv.step === "heroTitle") {
      const heroTitle = /^skip$/i.test(text) ? "" : text.slice(0, 120);
      if (text && !/^skip$/i.test(text)) userSay(text);
      setInterview({ ...iv, step: "bio", heroTitle });
      dannySay("Short bio — a line or two about you? (or “skip”)");
      return true;
    }

    if (iv.step === "bio") {
      const bio = /^skip$/i.test(text) ? "" : text.slice(0, 500);
      if (text && !/^skip$/i.test(text)) userSay(text.length > 120 ? text.slice(0, 120) + "…" : text);
      setInterview({ ...iv, step: "usernameHint", bio });
      dannySay("Username idea? 3–32 chars, lowercase (or “skip” and I'll suggest one).");
      return true;
    }

    if (iv.step === "usernameHint") {
      const hint = /^skip$/i.test(text) ? "" : text.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
      if (hint && !/^[a-z0-9_-]{3,32}$/.test(hint)) {
        dannySay("That needs to be 3–32 chars: lowercase letters, numbers, hyphens. Try again or “skip”.");
        return true;
      }
      if (text && !/^skip$/i.test(text)) userSay(hint);
      const done: InterviewState = { ...iv, step: "review", usernameHint: hint };
      setInterview(done);
      const kind =
        done.pageType === "personal"
          ? `personal page with a ${VIBE_LABELS[done.vibe ?? ""] ?? "custom"} vibe`
          : `business page (${BIZ_LABELS[done.bizType ?? ""] ?? "general"})`;
      dannySay(
        `Here's what I've got:\n• ${kind}\n• Name: ${done.displayName || "—"}\n• Tagline: ${done.heroTitle || "—"}\n• Bio: ${done.bio ? "✓" : "—"}\n• Username: ${done.usernameHint || "I'll suggest one"}\n\nReady to build it?`,
      );
      return true;
    }

    return false;
  };

  const confirmInterviewBuild = async () => {
    if (!interview || interview.step !== "review") return;
    const iv = interview;
    userSay("Build it!");
    const key =
      iv.pageType === "personal"
        ? `personal:${iv.vibe ?? "clean"}`
        : `business:${iv.bizType ?? "general"}`;
    const templateId = INTERVIEW_TEMPLATES[key] ?? HUMAN_TEMPLATES[0]?.id ?? "";
    setInterview(null);
    setInput("");
    await buildDraft({
      templateId,
      displayName: iv.displayName ?? "",
      heroTitle: iv.heroTitle ?? "",
      bio: iv.bio ?? "",
      usernameHint: iv.usernameHint ?? "",
    });
  };

  const buildDraft = async (fromInterview?: {
    templateId: string;
    displayName: string;
    heroTitle: string;
    bio: string;
    usernameHint: string;
  }) => {
    if (building) return;
    setError(null);
    setBuilding(true);
    const payload = fromInterview ?? {
      templateId: HUMAN_TEMPLATES[0]?.id ?? "",
      displayName: "",
      heroTitle: "",
      bio: "",
      usernameHint: "",
    };
    try {
      const res = await authedFetch("/api/liaison/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateId: payload.templateId,
          displayName: payload.displayName.trim(),
          heroTitle: payload.heroTitle.trim(),
          bio: payload.bio.trim(),
          usernameHint: payload.usernameHint.trim(),
        }),
      });
      const j = (await res.json().catch(() => null)) as {
        ok?: boolean;
        usernameHint?: string | null;
        error?: string;
      } | null;
      if (!res.ok || !j?.ok) {
        throw new Error(typeof j?.error === "string" ? j.error : "Couldn't build your draft.");
      }
      setBuildDone(true);
      setMessages((m) => [
        ...m,
        {
          role: "danny",
          text: `Your premade blockpage is ready — it's waiting in the builder, bound to your wallet. Open the builder and look for the "✨ Made for you" card at the top of the templates.`,
        },
      ]);
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't build your draft.");
    } finally {
      setBuilding(false);
    }
  };

  const chatPrice = status?.chatPriceHbar ?? 5;
  const buildPrice = status?.buildPriceHbar ?? 5;
  const chatPerPayment = status?.chatPerPayment ?? 50;
  // No free tier: every chat message and every help-build costs a fee.
  const credits =
    status == null
      ? null
      : status.chatLeft > 0 || status.buildsLeft > 0
        ? `${status.chatLeft} chats · ${status.buildsLeft} page build${status.buildsLeft === 1 ? "" : "s"} left`
        : "session empty";

  return (
    <section aria-label="Talk to Danny — paid help" style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <span aria-hidden style={{ fontSize: "1.4rem" }}>
          🦎
        </span>
        <div>
          <div style={{ fontWeight: 700, fontSize: "1.05rem", lineHeight: 1.2 }}>
            Talk to Danny
          </div>
          <div className="th-muted" style={{ fontSize: "0.82rem" }}>
            Paid helper — answers questions, builds your blockpage. Never touches your published
            page; only you hold the keys.
          </div>
        </div>
      </div>

      {!isAuthenticated ? (
        <p className="th-muted" style={{ fontSize: "0.9rem", margin: "12px 0 4px" }}>
          Connect your wallet and sign in to talk to Danny. Paid per product —
          chat is {chatPrice} HBAR for {chatPerPayment} messages, a page build is{" "}
          {buildPrice} HBAR. No free tier.
        </p>
      ) : (
        <>
          {credits && (
            <p className="th-muted" style={{ fontSize: "0.82rem", margin: "8px 0 0" }}>
              {credits}
            </p>
          )}
          {status && status.chatLeft === 0 && status.buildsLeft === 0 && (
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              {buyButton(
                "chat",
                `💬 Chat — ${chatPrice} HBAR (${chatPerPayment} messages)`,
              )}
              {buyButton("build", `✨ Build my page — ${buildPrice} HBAR`)}
            </div>
          )}
          {status != null && status.chatLeft <= 0 && status.buildsLeft > 0 && (
            <div style={{ marginTop: 8 }}>
              {buyButton("chat", `Buy chat — ${chatPrice} HBAR (${chatPerPayment} messages)`)}
            </div>
          )}

          <div
            aria-live="polite"
            style={{ maxHeight: 260, overflowY: "auto", margin: "12px 0", display: "flex", flexDirection: "column", gap: 8 }}
          >
            {messages.length === 0 && (
              <p className="th-muted" style={{ fontSize: "0.85rem" }}>
                Ask me about Voicescape — or say “build me a page” and I&apos;ll make you one.
              </p>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "85%",
                  padding: "8px 12px",
                  borderRadius: 10,
                  fontSize: "0.9rem",
                  lineHeight: 1.45,
                  background:
                    m.role === "user" ? "var(--vs-accent, #38bdf8)" : "var(--vs-glass)",
                  color: m.role === "user" ? "#0b0f16" : "var(--vs-text)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {m.text}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {error && (
            <p style={{ color: "#f87171", fontSize: "0.85rem", margin: "0 0 8px" }}>{error}</p>
          )}
          {payError && (
            <p style={{ color: "#f87171", fontSize: "0.85rem", margin: "0 0 8px" }}>{payError}</p>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendChat();
              }}
              placeholder={interview ? "Type your answer…" : "Ask Danny anything about Voicescape…"}
              maxLength={interview ? 500 : 1000}
              aria-label="Message Danny"
              style={{ ...inputStyle, flex: 1 }}
            />
            <button type="button" onClick={sendChat} disabled={busy || !input.trim()} style={btnStyle}>
              {busy ? "…" : "Send"}
            </button>
          </div>

          {/* Quick replies during interview choice steps */}
          {interview && (interview.step === "pageType" || interview.step === "vibe" || interview.step === "bizType" || interview.step === "review") && (
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              {interview.step === "pageType" && (
                <>
                  <button type="button" onClick={() => answerInterview("personal")} style={{ ...btnStyle, background: "var(--vs-glass)", color: "var(--vs-text)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                    🙋 Personal
                  </button>
                  <button type="button" onClick={() => answerInterview("business")} style={{ ...btnStyle, background: "var(--vs-glass)", color: "var(--vs-text)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                    💼 Business
                  </button>
                </>
              )}
              {interview.step === "vibe" && (
                <>
                  <button type="button" onClick={() => answerInterview("dark")} style={{ ...btnStyle, background: "var(--vs-glass)", color: "var(--vs-text)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                    🌙 Dark & chill
                  </button>
                  <button type="button" onClick={() => answerInterview("bright")} style={{ ...btnStyle, background: "var(--vs-glass)", color: "var(--vs-text)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                    ☀️ Bright & playful
                  </button>
                  <button type="button" onClick={() => answerInterview("bold")} style={{ ...btnStyle, background: "var(--vs-glass)", color: "var(--vs-text)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                    🎨 Bold & colorful
                  </button>
                  <button type="button" onClick={() => answerInterview("clean")} style={{ ...btnStyle, background: "var(--vs-glass)", color: "var(--vs-text)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                    ✨ Clean & minimal
                  </button>
                </>
              )}
              {interview.step === "bizType" && (
                <>
                  <button type="button" onClick={() => answerInterview("general")} style={{ ...btnStyle, background: "var(--vs-glass)", color: "var(--vs-text)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                    💼 General
                  </button>
                  <button type="button" onClick={() => answerInterview("food")} style={{ ...btnStyle, background: "var(--vs-glass)", color: "var(--vs-text)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                    🍔 Food & drink
                  </button>
                  <button type="button" onClick={() => answerInterview("shop")} style={{ ...btnStyle, background: "var(--vs-glass)", color: "var(--vs-text)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                    🛍️ Shop
                  </button>
                  <button type="button" onClick={() => answerInterview("services")} style={{ ...btnStyle, background: "var(--vs-glass)", color: "var(--vs-text)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                    💈 Services
                  </button>
                </>
              )}
              {interview.step === "review" && (
                <>
                  <button type="button" onClick={confirmInterviewBuild} disabled={building} style={{ ...btnStyle, fontSize: "0.85rem", padding: "8px 14px" }}>
                    {building ? "Building…" : "🔨 Build it!"}
                  </button>
                  <button type="button" onClick={() => { setInterview({ step: "pageType" }); dannySay("Let's start over — personal page or business?"); }} style={{ ...btnStyle, background: "transparent", color: "var(--vs-muted)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                    Start over
                  </button>
                </>
              )}
              <button type="button" onClick={cancelInterview} style={{ ...btnStyle, background: "transparent", color: "var(--vs-muted)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                Cancel
              </button>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            {!interview ? (
              <button
                type="button"
                onClick={startInterview}
                disabled={status != null && status.buildsLeft <= 0}
                style={{ ...btnStyle, background: "var(--vs-glass)", color: "var(--vs-text)", border: "1px solid var(--vs-border)" }}
              >
                ✨ Build me a blockpage
              </button>
            ) : (
              (interview.step === "displayName" || interview.step === "heroTitle" || interview.step === "bio" || interview.step === "usernameHint") && (
                <button type="button" onClick={cancelInterview} style={{ ...btnStyle, background: "transparent", color: "var(--vs-muted)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                  Cancel interview
                </button>
              )
            )}
            {interview == null && status != null && status.buildsLeft <= 0 && (
              buyButton("build", `Buy a build — ${buildPrice} HBAR`)
            )}
          </div>
          {buildDone && (
            <p style={{ marginTop: 10 }}>
              <a href="/builder" style={{ color: "var(--vs-accent, #38bdf8)", fontWeight: 700 }}>
                Open the builder →
              </a>{" "}
              <span className="th-muted" style={{ fontSize: "0.85rem" }}>
                your “✨ Made for you” card is at the top of the templates.
              </span>
            </p>
          )}

          {interview == null && status != null && (status.chatLeft > 0 || status.buildsLeft > 0) && (
            <p className="th-muted" style={{ fontSize: "0.78rem", margin: "10px 0 0" }}>
              Tips are non-refundable and split 98/2 on-chain. Publishing always happens with
              your own wallet — Danny can&apos;t do it for you.
            </p>
          )}
        </>
      )}
    </section>
  );
}
