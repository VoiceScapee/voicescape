"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { WalletConnect } from "@/components/WalletConnect";
import { useSession } from "@/lib/session";

interface Conversation {
  with: string;
  lastMessage: string;
  timestamp: number;
}

interface Message {
  from: string;
  to: string;
  message: string;
  timestamp: number;
}

/**
 * Direct Messages — simple wallet-to-wallet messaging.
 */
export default function DMsPage() {
  const { session, isAuthenticated, authHeader } = useSession();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [newRecipient, setNewRecipient] = useState("");
  const [loading, setLoading] = useState(true);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [blockedList, setBlockedList] = useState<string[]>([]);
  const [showReport, setShowReport] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reportMsg, setReportMsg] = useState<string | null>(null);

  const sessionHeaders = (): Record<string, string> => {
    return authHeader();
  };

  const myAddress = (session as any)?.address?.toLowerCase();

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    fetch("/api/dms", { headers: sessionHeaders() })
      .then((r) => r.json())
      .then((d) => {
        setConversations(d.conversations ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    // Block list
    fetch("/api/dms?blocks=1", { headers: sessionHeaders() })
      .then((r) => r.json())
      .then((d) => setBlockedList(d.blocked ?? []))
      .catch(() => {});
  }, [isAuthenticated]);

  // Poll the open thread so new replies appear without a manual reload.
  useEffect(() => {
    if (!selected || !isAuthenticated) return;
    const t = setInterval(() => loadThread(selected), 10000);
    return () => clearInterval(t);
  }, [selected, isAuthenticated]);

  const loadThread = async (withAddr: string) => {
    setSelected(withAddr);
    setSendError(null);
    setShowReport(false);
    setReportMsg(null);
    const res = await fetch(`/api/dms?with=${withAddr}`, { headers: sessionHeaders() });
    const data = await res.json();
    setMessages(data.messages ?? []);
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const to = selected || newRecipient.trim().toLowerCase();
    const msg = newMessage.trim();
    if (!to || !msg || sending) return;
    setSendError(null);
    setSending(true);

    try {
      const res = await fetch("/api/dms", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeaders() },
        body: JSON.stringify({ to, message: msg }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setNewMessage("");
        setNewRecipient("");
        // Reload thread and inbox
        if (to) loadThread(to);
        const inboxRes = await fetch("/api/dms", { headers: sessionHeaders() });
        const inboxData = await inboxRes.json();
        setConversations(inboxData.conversations ?? []);
      } else {
        // Never fail silently — the user must see why their message didn't send.
        setSendError(data.error || `Failed to send (HTTP ${res.status})`);
      }
    } catch {
      setSendError("Network error — message not sent. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  };

  const toggleBlock = async () => {
    if (!selected) return;
    const isBlocked = blockedList.includes(selected);
    setSendError(null);
    try {
      const res = await fetch("/api/dms", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeaders() },
        body: JSON.stringify({ action: isBlocked ? "unblock" : "block", address: selected }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setBlockedList(data.blocked ?? []);
      } else {
        setSendError(data.error || "Could not update block list");
      }
    } catch {
      setSendError("Network error — block list not updated.");
    }
  };

  const submitReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || reportReason.trim().length < 10) return;
    setReportMsg(null);
    try {
      const res = await fetch("/api/dms", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeaders() },
        body: JSON.stringify({ action: "report", address: selected, reason: reportReason.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setReportMsg("Report sent — a moderator will review it.");
        setReportReason("");
        setShowReport(false);
      } else {
        setReportMsg(data.error || "Could not send report");
      }
    } catch {
      setReportMsg("Network error — report not sent.");
    }
  };

  const isBlocked = selected ? blockedList.includes(selected) : false;

  const shortAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

  if (!isAuthenticated) {
    return (
      <main style={{ minHeight: "100vh", background: "var(--vs-bg)" }}>
        <Navbar right={<WalletConnect />} />
        <div style={{ maxWidth: 600, margin: "0 auto", padding: "64px 18px", textAlign: "center" }}>
          <h1>Messages</h1>
          <p style={{ color: "var(--vs-muted)", marginBottom: 24 }}>
            Connect your wallet to view messages.
          </p>
          <WalletConnect />
        </div>
      </main>
    );
  }

  return (
    <main style={{ minHeight: "100vh", background: "var(--vs-bg)" }}>
      <Navbar right={<WalletConnect />} />

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 18px" }}>
        <h1 style={{ marginBottom: 24 }}>💬 Messages</h1>

        {sendError && (
          <div
            role="alert"
            style={{
              marginBottom: 16,
              padding: "12px 16px",
              borderRadius: 10,
              background: "rgba(255,80,80,0.12)",
              border: "1px solid rgba(255,80,80,0.4)",
              color: "#ff8a8a",
              fontSize: 14,
            }}
          >
            ⚠️ {sendError}
          </div>
        )}
        {reportMsg && (
          <div
            role="status"
            style={{
              marginBottom: 16,
              padding: "12px 16px",
              borderRadius: 10,
              background: "rgba(80,200,120,0.12)",
              border: "1px solid rgba(80,200,120,0.4)",
              color: "#8ae8a8",
              fontSize: 14,
            }}
          >
            {reportMsg}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 280px) minmax(0, 1fr)", gap: 16 }} className="dm-grid">
          {/* Inbox */}
          <div
            style={{
              border: "1px solid var(--vs-border)",
              borderRadius: 12,
              background: "var(--vs-glass)",
              overflow: "hidden",
            }}
          >
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--vs-border)", fontWeight: 600 }}>
              Inbox
            </div>
            {loading ? (
              <div style={{ padding: 16, color: "var(--vs-muted)", fontSize: 13 }}>Loading…</div>
            ) : conversations.length === 0 ? (
              <div style={{ padding: 16, color: "var(--vs-muted)", fontSize: 13 }}>
                No conversations yet.
              </div>
            ) : (
              conversations.map((c) => (
                <button
                  key={c.with}
                  onClick={() => loadThread(c.with)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "12px 16px",
                    border: "none",
                    borderBottom: "1px solid var(--vs-border)",
                    background: selected === c.with ? "var(--vs-bg)" : "transparent",
                    color: "inherit",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 14, fontFamily: "monospace" }}>
                    {shortAddr(c.with)}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--vs-muted)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.lastMessage}
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Thread */}
          <div
            style={{
              border: "1px solid var(--vs-border)",
              borderRadius: 12,
              background: "var(--vs-glass)",
              display: "flex",
              flexDirection: "column",
              minHeight: 400,
            }}
          >
            {!selected ? (
              <div style={{ padding: 32, textAlign: "center", color: "var(--vs-muted)" }}>
                <p style={{ marginBottom: 16 }}>Select a conversation or start a new one.</p>
                <form onSubmit={sendMessage} style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 400, margin: "0 auto" }}>
                  <input
                    type="text"
                    value={newRecipient}
                    onChange={(e) => setNewRecipient(e.target.value)}
                    placeholder="Recipient address (0x…)"
                    style={{
                      padding: "10px 14px",
                      borderRadius: 8,
                      border: "1px solid var(--vs-border)",
                      background: "var(--vs-bg)",
                      color: "inherit",
                      fontSize: 13,
                    }}
                  />
                  <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    placeholder="Type your message…"
                    style={{
                      padding: "10px 14px",
                      borderRadius: 8,
                      border: "1px solid var(--vs-border)",
                      background: "var(--vs-bg)",
                      color: "inherit",
                      fontSize: 13,
                    }}
                  />
                  <button
                    type="submit"
                    disabled={!newRecipient.trim() || !newMessage.trim()}
                    className="vs-btn vs-btn-primary"
                    style={{ padding: "10px 14px", fontSize: 14 }}
                  >
                    Send message
                  </button>
                </form>
              </div>
            ) : (
              <>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--vs-border)", display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    onClick={() => setSelected(null)}
                    className="dm-back"
                    style={{
                      display: "none",
                      background: "transparent",
                      border: "1px solid var(--vs-border)",
                      borderRadius: 8,
                      color: "inherit",
                      padding: "4px 10px",
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    ← Inbox
                  </button>
                  <span style={{ fontWeight: 600, fontFamily: "monospace", fontSize: 14, flex: 1 }}>
                    {shortAddr(selected)}
                  </span>
                  <button
                    onClick={toggleBlock}
                    title={isBlocked ? "Unblock this user" : "Block this user"}
                    style={{
                      background: "transparent",
                      border: "1px solid var(--vs-border)",
                      borderRadius: 8,
                      color: isBlocked ? "#ff8a8a" : "inherit",
                      padding: "4px 10px",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    {isBlocked ? "Unblock" : "Block"}
                  </button>
                  <button
                    onClick={() => { setShowReport((v) => !v); setReportMsg(null); }}
                    title="Report this user"
                    style={{
                      background: "transparent",
                      border: "1px solid var(--vs-border)",
                      borderRadius: 8,
                      color: "inherit",
                      padding: "4px 10px",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    Report
                  </button>
                </div>
                {showReport && (
                  <form
                    onSubmit={submitReport}
                    style={{ padding: 12, borderBottom: "1px solid var(--vs-border)", display: "flex", flexDirection: "column", gap: 8 }}
                  >
                    <textarea
                      value={reportReason}
                      onChange={(e) => setReportReason(e.target.value)}
                      placeholder="Why are you reporting this user? (min 10 chars)"
                      rows={3}
                      style={{
                        padding: "10px 14px",
                        borderRadius: 8,
                        border: "1px solid var(--vs-border)",
                        background: "var(--vs-bg)",
                        color: "inherit",
                        fontSize: 13,
                        resize: "vertical",
                      }}
                    />
                    <button
                      type="submit"
                      disabled={reportReason.trim().length < 10}
                      className="vs-btn vs-btn-primary"
                      style={{ padding: "8px 14px", fontSize: 13, alignSelf: "flex-start" }}
                    >
                      Submit report
                    </button>
                  </form>
                )}
                {isBlocked && (
                  <div style={{ padding: "8px 16px", fontSize: 12, color: "#ff8a8a", borderBottom: "1px solid var(--vs-border)" }}>
                    You blocked this user — they can't message you.
                  </div>
                )}
                <div style={{ flex: 1, padding: 16, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
                  {messages.map((m, i) => (
                    <div
                      key={i}
                      style={{
                        alignSelf: m.from === myAddress ? "flex-end" : "flex-start",
                        maxWidth: "70%",
                        padding: "8px 12px",
                        borderRadius: 12,
                        background: m.from === myAddress ? "var(--vs-accent)" : "var(--vs-bg)",
                        color: m.from === myAddress ? "white" : "inherit",
                        fontSize: 14,
                      }}
                    >
                      {m.message}
                    </div>
                  ))}
                </div>
                <form
                  onSubmit={sendMessage}
                  style={{ padding: 12, borderTop: "1px solid var(--vs-border)", display: "flex", gap: 8 }}
                >
                  <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    placeholder="Type a message…"
                    style={{
                      flex: 1,
                      padding: "10px 14px",
                      borderRadius: 8,
                      border: "1px solid var(--vs-border)",
                      background: "var(--vs-bg)",
                      color: "inherit",
                      fontSize: 14,
                    }}
                  />
                  <button
                    type="submit"
                    className="vs-btn vs-btn-primary"
                    style={{ padding: "10px 20px" }}
                    disabled={sending || !newMessage.trim()}
                  >
                    {sending ? "Sending…" : "Send"}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </div>
      <style jsx>{`
        @media (max-width: 640px) {
          .dm-grid {
            grid-template-columns: 1fr !important;
          }
          .dm-back {
            display: inline-block !important;
          }
        }
      `}</style>
    </main>
  );
}
