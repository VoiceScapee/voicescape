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
import {
  clearBrowserCelebration,
  congratsText,
  takeBrowserCelebration,
} from "@/lib/liaison-celebrate";
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
  const statusRef = useRef<LiaisonStatus | null>(null);
  statusRef.current = status;

  const dannySay = (text: string) =>
    setMessages((m) => [...m, { role: "danny", text }]);
  const userSay = (text: string) =>
    setMessages((m) => [...m, { role: "user", text }]);

  const startInterview = useCallback(() => {
    if (statusRef.current != null && statusRef.current.buildsLeft <= 0) return;
    setError(null);
    setInterview({ step: "describe" });
    dannySay(
      "Let's build your page! Describe what you want — the vibe, colors, sections, what it's for. Write it like you'd tell a friend.",
    );
  }, []);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pay flow
  const [paying, setPaying] = useState<LiaisonProduct | null>(null);
  const [payStage, setPayStage] = useState<"wallet" | "confirming" | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [reverifyBusy, setReverifyBusy] = useState(false);

  const [confirmTxId, setConfirmTxId] = useState<string | null>(null);
  const [confirmProduct, setConfirmProduct] = useState<LiaisonProduct | null>(null);
  const confirmStatus = useConfirmedTransaction(confirmTxId);

  // Build interview — conversational flow that replaces the rigid form.
  // After paying for a build, Danny interviews the user in the chat:
  // page type → vibe/business type → name → tagline → bio → username →
  // review → draft. No chat credits consumed; the build was already paid.
  // Build interview: a natural 3-question chat flow. The user describes
  // what they want in their own words (in the normal chat box), then gives
  // a display name and username. No rigid form, no quick-reply buttons —
  // just conversation.
  type InterviewStep = "describe" | "displayName" | "usernameHint" | "review";
  interface InterviewState {
    step: InterviewStep;
    description?: string;
    displayName?: string;
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
        // Server lane: the server clears its flag on read, so this shows
        // exactly once. Browser lane: same-browser backup for when the
        // server flag was lost (ephemeral server KV); also once, then
        // cleared. Server lane wins — its flag also drops the backup so
        // the message can never double-fire.
        if (s.celebratedUsername) {
          clearBrowserCelebration();
          setMessages((m) => [
            ...m,
            {
              role: "danny",
              text: congratsText(s.celebratedUsername as string),
            },
          ]);
        } else {
          const pending = takeBrowserCelebration(Date.now(), account ?? undefined);
          if (pending) {
            setMessages((m) => [
              ...m,
              {
                role: "danny",
                text: congratsText(pending),
              },
            ]);
          }
        }
      }
    } catch {
      /* panel stays usable without status */
    }
  }, [authedFetch, account]);

  // Re-verify a payment: scans on-chain for the user's newest unconsumed
  // tip and credits it, without requiring a new payment. For users hit by
  // the 98/2 verification bug — their HBAR is on-chain, just uncredited.
  const reverify = async (product: "chat" | "build") => {
    setReverifyBusy(true);
    setPayError(null);
    try {
      const res = await authedFetch("/api/liaison/verify-tip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scan: true, product }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok) {
        await refreshStatus();
        // Build re-verified → start the interview immediately.
        if (product === "build") startInterview();
      } else {
        setPayError(typeof j?.error === "string" ? j.error : "No unused payment found on-chain.");
      }
    } catch {
      setPayError("Couldn't reach the server — try again.");
    } finally {
      setReverifyBusy(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated) refreshStatus();
    else setStatus(null);
  }, [isAuthenticated, refreshStatus]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);

  // Tip approved → confirmed on-chain → verify with the server for the
  // product that was bought. The verify call has a hard 30s timeout: if the
  // network or server hangs, the button must not stick on
  // "Confirming on-chain…" forever — the user gets a retryable error and
  // the tx can be re-verified (verify-tip is idempotent on txHash).
  useEffect(() => {
    if (!confirmTxId) return;
    if (confirmStatus === "confirmed") {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      authedFetch("/api/liaison/verify-tip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash: confirmTxId, product: confirmProduct ?? "chat" }),
        signal: controller.signal,
      })
        .then(async (r) => {
          const j = await r.json().catch(() => null);
          if (r.ok) {
            setPayError(null);
            await refreshStatus();
            // Build purchased → Danny immediately starts the conversation.
            // No dead end, no hunting for a button — he asks what you want.
            if (confirmProduct === "build") {
              startInterview();
            }
          } else {
            setPayError(
              typeof j?.error === "string" ? j.error : "Couldn't unlock your purchase — try again.",
            );
          }
        })
        .catch(() => setPayError("Couldn't unlock your purchase — the request timed out. Your payment is safe; try again and it will be credited."))
        .finally(() => {
          clearTimeout(timeout);
          setPaying(null);
          setPayStage(null);
          setConfirmTxId(null);
          setConfirmProduct(null);
        });
      return () => {
        clearTimeout(timeout);
        controller.abort();
      };
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
  }, [confirmStatus, confirmTxId, confirmProduct, authedFetch, refreshStatus, startInterview]);

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
    // The purchase must be credited to a signed-in session — without one,
    // verify-tip has no wallet to unlock and the button sticks on
    // "Confirming on-chain…". Fail fast with a clear message instead.
    if (!isAuthenticated) {
      setPayError("Sign in with your wallet first, then pay — the purchase is credited to your signed-in session.");
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

  const cancelInterview = () => {
    setInterview(null);
    setInput("");
    dannySay("No worries — we can build whenever you're ready. Just tap “✨ Build me a blockpage”.");
  };

  /** Pick a starting template from keywords in the user's description. */
  const pickTemplateFromDescription = (desc: string): string => {
    const t = desc.toLowerCase();
    if (t.includes("restaurant") || t.includes("food") || t.includes("cafe") || t.includes("menu")) return "restaurant";
    if (t.includes("shop") || t.includes("store") || t.includes("sell") || t.includes("product")) return "retail-shop";
    if (t.includes("business") || t.includes("company") || t.includes("service")) return "business-card";
    if (t.includes("dark") || t.includes("moody") || t.includes("chill") || t.includes("lofi")) return "lofi-room";
    if (t.includes("bright") || t.includes("playful") || t.includes("colorful") || t.includes("fun")) return "solarpunk-garden";
    if (t.includes("bold") || t.includes("neon") || t.includes("vibrant")) return "aurora-drift";
    return "wanderer-atlas"; // clean default
  };

  /** Advance the interview one step. Returns true when the answer was consumed. */
  const answerInterview = (raw: string): boolean => {
    if (!interview) return false;
    const text = raw.trim();
    if (!text) return false;
    const iv = interview;

    if (iv.step === "describe") {
      userSay(text);
      setInterview({ ...iv, step: "displayName", description: text });
      dannySay("Love it. What name should the page show at the top?");
      return true;
    }

    if (iv.step === "displayName") {
      userSay(text);
      setInterview({ ...iv, step: "usernameHint", displayName: text });
      dannySay("And what username do you want? (lowercase letters, numbers, dashes — like your-page)");
      return true;
    }

    if (iv.step === "usernameHint") {
      const username = text.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
      if (!username || username.length < 3) {
        dannySay("That username won't work — needs at least 3 characters, lowercase letters/numbers/dashes. Try another?");
        return true;
      }
      userSay(username);
      setInterview({ ...iv, step: "review", usernameHint: username });
      dannySay(
        `Here's what I'm building:\n• Name: ${iv.displayName}\n• Username: @${username}\n• Your vision: "${iv.description}"\n\nTap "Build it" below, or type "start over" to redo it.`,
      );
      return true;
    }

    if (iv.step === "review") {
      const t = text.toLowerCase();
      if (t.includes("start over") || t.includes("redo") || t.includes("restart")) {
        setInterview({ step: "describe" });
        dannySay("No problem — describe your page again, fresh start.");
        return true;
      }
      return false; // let the Build button handle it
    }

    return false;
  };

  const confirmInterviewBuild = async () => {
    if (!interview || interview.step !== "review") return;
    const iv = interview;
    userSay("Build it!");
    // Pick the starting template from keywords in their description.
    const templateId = pickTemplateFromDescription(iv.description ?? "");
    setInterview(null);
    setInput("");
    await buildDraft({
      templateId,
      displayName: iv.displayName ?? "",
      heroTitle: iv.displayName ?? "",
      bio: iv.description ?? "",
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
          {/* Re-verify: if the user paid but the credit didn't land (e.g. the
              98/2 bug), scan on-chain for their unconsumed tip instead of
              making them pay again. */}
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={reverifyBusy}
              onClick={() => reverify("chat")}
              style={{ ...btnStyle, background: "transparent", border: "1px solid var(--vs-border)", fontSize: "0.8rem", padding: "6px 10px" }}
            >
              {reverifyBusy ? "Checking…" : "I paid for chat — check again"}
            </button>
            <button
              type="button"
              disabled={reverifyBusy}
              onClick={() => reverify("build")}
              style={{ ...btnStyle, background: "transparent", border: "1px solid var(--vs-border)", fontSize: "0.8rem", padding: "6px 10px" }}
            >
              {reverifyBusy ? "Checking…" : "I paid for a build — check again"}
            </button>
          </div>

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

          {/* Interview controls: just Build / Start over / Cancel at review.
              Everything else is typed in the chat box — no quick-reply
              buttons, no rigid form. */}
          {interview && interview.step === "review" && (
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button type="button" onClick={confirmInterviewBuild} disabled={building} style={{ ...btnStyle, fontSize: "0.85rem", padding: "8px 14px" }}>
                {building ? "Building…" : "🔨 Build it!"}
              </button>
              <button type="button" onClick={() => { setInterview({ step: "describe" }); dannySay("No problem — describe your page again, fresh start."); }} style={{ ...btnStyle, background: "transparent", color: "var(--vs-muted)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                Start over
              </button>
              <button type="button" onClick={cancelInterview} style={{ ...btnStyle, background: "transparent", color: "var(--vs-muted)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                Cancel
              </button>
            </div>
          )}
          {interview && interview.step !== "review" && (
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button type="button" onClick={cancelInterview} style={{ ...btnStyle, background: "transparent", color: "var(--vs-muted)", border: "1px solid var(--vs-border)", fontSize: "0.85rem", padding: "8px 14px" }}>
                Cancel
              </button>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            {!interview && status != null && status.buildsLeft > 0 && (
              <button
                type="button"
                onClick={startInterview}
                style={{ ...btnStyle, background: "var(--vs-glass)", color: "var(--vs-text)", border: "1px solid var(--vs-border)" }}
              >
                ✨ Build me a blockpage
              </button>
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
