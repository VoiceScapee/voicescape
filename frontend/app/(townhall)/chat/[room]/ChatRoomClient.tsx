"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import ReportButton from "@/components/townhall/ReportButton";
import { PresenceDot } from "@/components/townhall/Presence";
import { useWriteGate } from "@/components/townhall/useTownhall";
import { useHcsSubmit } from "@/components/townhall/useHcsSubmit";
import { useStreamEvents } from "@/components/townhall/useStream";
import { postJson, timeAgo, type ChatMessage } from "@/lib/townhall";

function isChatMessage(m: unknown): m is ChatMessage {
  return (
    !!m &&
    typeof m === "object" &&
    typeof (m as ChatMessage).seq === "number" &&
    typeof (m as ChatMessage).body === "string"
  );
}

export default function ChatRoomClient({ room }: { room: string }) {
  const { username: me, canWrite, isAuthenticated } = useWriteGate();
  const hcs = useHcsSubmit();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [body, setBody] = useState("");
  const seenRef = useRef<Set<number>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamUrl = `/api/townhall/chat/${encodeURIComponent(room)}/stream`;

  const addMessages = useCallback((incoming: ChatMessage[]) => {
    if (incoming.length === 0) return;
    setMessages((prev) => {
      const fresh = incoming.filter((m) => !seenRef.current.has(m.seq));
      if (fresh.length === 0) return prev;
      fresh.forEach((m) => seenRef.current.add(m.seq));
      return [...prev, ...fresh]
        .sort((a, b) => a.seq - b.seq)
        .slice(-300);
    });
  }, []);

  const conn = useStreamEvents<ChatMessage>(streamUrl, addMessages, isChatMessage);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const send = async () => {
    const text = body.trim();
    if (!text || !canWrite || !me) return;
    // Submit the chat message via the user's wallet, then notify the server
    // (it verifies the HCS tx via mirror node).
    const hcsTxId = await hcs.submit("chat", {
      v: 1,
      kind: "chat",
      ts: new Date().toISOString(),
      author: me,
      room,
      body: text,
    });
    if (!hcsTxId) return; // User cancelled or error — phase shows the error
    try {
      await postJson(streamUrl.replace(/\/stream$/, ""), {
        author: me,
        body: text,
        hcsTxId,
      });
    } catch (e) {
      // Server verification failed — the HCS tx is still on-chain, but the
      // server didn't accept it (e.g., content filter). Show the error.
      console.error("Chat verification failed:", e);
      return;
    }
    setBody("");
    // Optimistic: show it now with a temp seq; the stream dedupes when the real copy arrives.
    const tempSeq = -Date.now();
    addMessages([
      { seq: tempSeq, room, author: me, body: text, ts: new Date().toISOString() } as unknown as ChatMessage,
    ]);
  };

  return (
    <>
      <div className="th-page-head">
        <h1>#{room}</h1>
        <p className={`th-chat-status ${conn === "live" ? "is-live" : conn === "polling" ? "is-retry" : ""}`}>
          {conn === "live" && "● live"}
          {conn === "connecting" && "○ connecting…"}
          {conn === "polling" && "◌ reconnecting — polling every 5s"}
          {conn === "error" && "✕ connection failed"}
          {" · "}
          <PresenceDot scope={`chat:${room}`} />
          {" · "}
          <Link href="/chat" className="th-identity-link">all rooms</Link>
        </p>
      </div>

      <div className="th-chat-feed" aria-live="polite" aria-label={`Messages in ${room}`}>
        {messages.length === 0 && (
          <p className="th-muted">No messages yet — break the ice.</p>
        )}
        {messages.map((m) => (
          <div key={m.seq} className={`th-chat-msg${m.author === me ? " is-mine" : ""}`}>
            <div className="th-chat-head">
              <Link href={`/${m.author}`} className="th-post-author">
                @{m.author}
              </Link>
              <span className="th-post-ts">{timeAgo(m.ts)}</span>
              {m.author !== me && <ReportButton targetKind="chat" targetSeq={m.seq} />}
            </div>
            <p className="th-chat-body">{m.body}</p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="th-composer">
        <div className="th-composer-row">
          <input
            className="vs-input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={me ? `Message #${room} as @${me}…` : isAuthenticated ? "Set your page username (top of the page) to chat…" : "Sign in with your wallet to chat…"}
            aria-label={`Message ${room}`}
            maxLength={500}
          />
          <button
            type="button"
            className="vs-btn vs-btn-primary th-btn-sm"
            onClick={send}
            disabled={!body.trim() || !canWrite || hcs.phase.kind === "submitting"}
          >
            {hcs.phase.kind === "submitting" ? "…" : "Send"}
          </button>
        </div>
        {!canWrite && <p className="th-muted" style={{ marginTop: 8 }}>{isAuthenticated ? "You need a page username to chat." : "Sign in with your wallet to chat."}</p>}
        {hcs.phase.kind === "error" && (
          <p className="th-error" style={{ marginTop: 8 }}>Failed to submit: {hcs.phase.message}</p>
        )}
      </div>
    </>
  );
}
