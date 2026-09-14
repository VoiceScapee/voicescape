"use client";

/**
 * DannyLiaisonPanel — the paid human-facing helper on danny's blockpage.
 *
 * Humans connect their wallet, sign in, and can:
 * - tip to unlock a help session (50 chats + 1 page build) — every chat
 *   message and every help-build costs a fee; there is no free tier,
 * - ask Danny to build them a premade blockpage draft, bound to their wallet.
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
  priceHbar: number;
  chatLeft: number;
  buildsLeft: number;
  expMs: number | null;
}

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
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [confirmTxId, setConfirmTxId] = useState<string | null>(null);
  const confirmStatus = useConfirmedTransaction(confirmTxId);

  // Build form
  const [showBuild, setShowBuild] = useState(false);
  const [templateId, setTemplateId] = useState(HUMAN_TEMPLATES[0]?.id ?? "");
  const [displayName, setDisplayName] = useState("");
  const [heroTitle, setHeroTitle] = useState("");
  const [bio, setBio] = useState("");
  const [usernameHint, setUsernameHint] = useState("");
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
      if (res.ok) setStatus((await res.json()) as LiaisonStatus);
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

  // Tip approved → confirmed on-chain → verify with the server.
  useEffect(() => {
    if (!confirmTxId) return;
    if (confirmStatus === "confirmed") {
      authedFetch("/api/liaison/verify-tip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash: confirmTxId }),
      })
        .then(async (r) => {
          const j = await r.json().catch(() => null);
          if (r.ok) {
            setPayError(null);
            await refreshStatus();
          } else {
            setPayError(
              typeof j?.error === "string" ? j.error : "Couldn't unlock your session — try again.",
            );
          }
        })
        .catch(() => setPayError("Couldn't unlock your session — try again."))
        .finally(() => {
          setPaying(false);
          setConfirmTxId(null);
        });
    } else if (confirmStatus === "failed") {
      setPayError("The tip transaction failed on-chain — no payment was sent.");
      setPaying(false);
      setConfirmTxId(null);
    } else if (confirmStatus === "timeout") {
      setPayError("Tip submitted but not yet visible — give it a moment, then refresh.");
      setPaying(false);
      setConfirmTxId(null);
    }
  }, [confirmStatus, confirmTxId, authedFetch, refreshStatus]);

  const sendChat = async () => {
    const text = input.trim();
    if (!text || busy) return;
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

  const pay = async () => {
    setPayError(null);
    if (!account) {
      setPayError("Connect a wallet first.");
      return;
    }
    const price = status?.priceHbar ?? 5;
    setPaying(true);
    try {
      const sender = await getTxSender();
      // tipPage takes an 18-decimal valueWei. HBAR on the EVM side of
      // Hedera is 10^18 wei per HBAR (same as ethers' ether units) —
      // parseUnits from the price string keeps non-integer prices exact.
      const wei = ethers.parseUnits(price.toString(), 18);
      const hash = await tipPage("danny", wei, sender);
      // Approved — wait for real on-chain confirmation before unlocking.
      setConfirmTxId(hash);
    } catch (e) {
      setPayError(`Tip failed: ${friendlyWalletError(e)}`);
      setPaying(false);
    }
  };

  const buildDraft = async () => {
    if (building) return;
    setError(null);
    setBuilding(true);
    try {
      const res = await authedFetch("/api/liaison/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateId,
          displayName: displayName.trim(),
          heroTitle: heroTitle.trim(),
          bio: bio.trim(),
          usernameHint: usernameHint.trim(),
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

  const price = status?.priceHbar ?? 5;
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
          Connect your wallet and sign in to talk to Danny. Chat is paid — tip
          to unlock a help session (no free tier).
        </p>
      ) : (
        <>
          {credits && (
            <p className="th-muted" style={{ fontSize: "0.82rem", margin: "8px 0 0" }}>
              {credits}
              {status && status.chatLeft === 0 && status.buildsLeft === 0 && (
                <>
                  {" — "}
                  <button
                    type="button"
                    onClick={pay}
                    disabled={paying}
                    style={{ ...btnStyle, padding: "6px 12px", fontSize: "0.82rem" }}
                  >
                    {paying ? "Working…" : `Unlock help — ${price} HBAR`}
                  </button>
                </>
              )}
            </p>
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
              placeholder="Ask Danny anything about Voicescape…"
              maxLength={1000}
              aria-label="Message Danny"
              style={{ ...inputStyle, flex: 1 }}
            />
            <button type="button" onClick={sendChat} disabled={busy || !input.trim()} style={btnStyle}>
              {busy ? "…" : "Send"}
            </button>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            {!showBuild ? (
              <button
                type="button"
                onClick={() => setShowBuild(true)}
                disabled={status != null && status.buildsLeft <= 0}
                style={{ ...btnStyle, background: "var(--vs-glass)", color: "var(--vs-text)", border: "1px solid var(--vs-border)" }}
              >
                ✨ Build me a blockpage
              </button>
            ) : (
              <div style={{ width: "100%", borderTop: "1px solid var(--vs-border)", paddingTop: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Your premade blockpage</div>
                <label style={{ display: "block", fontSize: 13, marginBottom: 4, color: "var(--vs-muted)" }}>
                  Starting template
                </label>
                <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={{ ...inputStyle, marginBottom: 8 }}>
                  {HUMAN_TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} — {t.description}
                    </option>
                  ))}
                </select>
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name (hero title)" maxLength={60} aria-label="Your name" style={{ ...inputStyle, marginBottom: 8 }} />
                <input value={heroTitle} onChange={(e) => setHeroTitle(e.target.value)} placeholder="Tagline (e.g. Web3 builder & creator)" maxLength={120} aria-label="Tagline" style={{ ...inputStyle, marginBottom: 8 }} />
                <textarea value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Short bio" maxLength={500} rows={2} aria-label="Bio" style={{ ...inputStyle, marginBottom: 8, resize: "vertical" }} />
                <input value={usernameHint} onChange={(e) => setUsernameHint(e.target.value)} placeholder="Username idea (3–32: a-z 0-9 - _)" maxLength={32} aria-label="Username idea" style={{ ...inputStyle, marginBottom: 8 }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" onClick={buildDraft} disabled={building || (status != null && status.buildsLeft <= 0)} style={btnStyle}>
                    {building ? "Building…" : `Build it${status && status.buildsLeft > 0 ? ` (${status.buildsLeft} left)` : ""}`}
                  </button>
                  <button type="button" onClick={() => setShowBuild(false)} style={{ ...btnStyle, background: "transparent", color: "var(--vs-muted)", border: "1px solid var(--vs-border)" }}>
                    Cancel
                  </button>
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
              </div>
            )}
          </div>

          {!showBuild && status != null && (status.chatLeft > 0 || status.buildsLeft > 0) && (
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
