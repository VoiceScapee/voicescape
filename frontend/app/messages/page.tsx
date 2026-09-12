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
  }, [isAuthenticated]);

  const loadThread = async (withAddr: string) => {
    setSelected(withAddr);
    const res = await fetch(`/api/dms?with=${withAddr}`, { headers: sessionHeaders() });
    const data = await res.json();
    setMessages(data.messages ?? []);
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const to = selected || newRecipient.trim().toLowerCase();
    const msg = newMessage.trim();
    if (!to || !msg) return;

    const res = await fetch("/api/dms", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders() },
      body: JSON.stringify({ to, message: msg }),
    });

    if (res.ok) {
      setNewMessage("");
      setNewRecipient("");
      // Reload thread and inbox
      if (to) loadThread(to);
      const inboxRes = await fetch("/api/dms", { headers: sessionHeaders() });
      const inboxData = await inboxRes.json();
      setConversations(inboxData.conversations ?? []);
    }
  };

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

        <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 16 }}>
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
                <form onSubmit={sendMessage} style={{ display: "flex", gap: 8, maxWidth: 400, margin: "0 auto" }}>
                  <input
                    type="text"
                    value={newRecipient}
                    onChange={(e) => setNewRecipient(e.target.value)}
                    placeholder="Recipient address (0x…)"
                    style={{
                      flex: 1,
                      padding: "10px 14px",
                      borderRadius: 8,
                      border: "1px solid var(--vs-border)",
                      background: "var(--vs-bg)",
                      color: "inherit",
                      fontSize: 13,
                    }}
                  />
                </form>
              </div>
            ) : (
              <>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--vs-border)", fontWeight: 600, fontFamily: "monospace", fontSize: 14 }}>
                  {shortAddr(selected)}
                </div>
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
                  >
                    Send
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
