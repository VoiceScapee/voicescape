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
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const seenRef = useRef<Set<number>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamUrl = `/api/townhall/chat/${encodeURIComponent(room)}/stream`;

  const addMessages = useCallback((incoming: ChatMessage[]) => {
    if (incoming.length === 0) return;
    setMessages((prev) => {
      const fresh = incoming.filter((m) => !seenRef.current.has(m.seq));
      if (fresh.length === 0) return prev;
      fresh.forEach((m) => seenRef.current.add(m.seq));
      // When a real (positive-seq) message arrives from me, drop any pending
      // optimistic copy with the same room+body — the temp negative seq
      // never dedupes by seq alone.
      const confirmedKeys = new Set(
        fresh
          .filter((m) => m.seq > 0 && m.author === me)
          .map((m) => `${m.room}::${m.body}`),
      );
      const prevFiltered =
        confirmedKeys.size > 0
          ? prev.filter(
              (m) =>
                !(
                  (m as unknown as { pending?: boolean }).pending &&
                  confirmedKeys.has(`${m.room}::${m.body}`)
                ),
            )
          : prev;
      return [...prevFiltered, ...fresh]
        .sort((a, b) => a.seq - b.seq)
        .slice(-300);
    });
  }, [me]);

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
    setBody("");
    setVerifyError(null);
    // Optimistic: show it NOW, before server verification. The HCS tx is
    // already on-chain (user paid + signed), so the message WILL appear once
    // the mirror node indexes it. The stream dedupes when the real copy arrives.
    const tempSeq = -Date.now();
    const optimisticMsg = {
      seq: tempSeq,
      room,
      author: me,
      body: text,
      ts: new Date().toISOString(),
      pending: true,
    } as unknown as ChatMessage;
    addMessages([optimisticMsg]);
    // Notify the server with retries: the mirror node can lag several seconds
    // behind consensus, so the first verification attempt may 404. The txId
    // reservation is released on failure, so retrying is safe.
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await postJson(streamUrl.replace(/\/stream$/, ""), {
          author: me,
          body: text,
          hcsTxId,
        });
        // Verified — the pending flag will clear when the stream delivers
        // the real message (dedupe replaces it). Nothing more to do.
        return;
      } catch (e) {
        const isLast = attempt === maxAttempts;
        console.error(`Chat verification attempt ${attempt}/${maxAttempts} failed:`, e);
        if (isLast) {
          // The HCS tx is still on-chain — the message will appear once the
          // mirror node indexes it. Mark it so the user knows it's pending.
          // (The optimistic message stays visible with its pending state.)
          setVerifyError(
            "Sent to Hedera, but confirmation is delayed — your message will appear shortly.",
          );
          return;
        }
        // Backoff before retry: 2s, 4s
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
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
              {(m as unknown as { pending?: boolean }).pending && (
                <span className="th-muted" title="Sent to Hedera — waiting for network confirmation"> ◌ sending…</span>
              )}
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
        {verifyError && (
          <p className="th-muted" style={{ marginTop: 8 }}>◌ {verifyError}</p>
        )}
      </div>
    </>
  );
}
