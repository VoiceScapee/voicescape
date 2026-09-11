"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import DustFeeGate from "@/components/townhall/DustFeeGate";
import ReportButton from "@/components/townhall/ReportButton";
import { useDustFee, useWriteGate } from "@/components/townhall/useTownhall";
import { postJson, timeAgo, type ChatMessage } from "@/lib/townhall";

type ConnState = "connecting" | "live" | "polling" | "error";

function parseSseChunk(text: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    try {
      const msg = JSON.parse(t.slice(5).trim()) as ChatMessage;
      if (msg && typeof msg.seq === "number" && typeof msg.body === "string") out.push(msg);
    } catch {
      // partial line — skip
    }
  }
  return out;
}

export default function ChatRoomClient({ room }: { room: string }) {
  const { username: me, canWrite, isAuthenticated } = useWriteGate();
  const dust = useDustFee();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [body, setBody] = useState("");
  const seenRef = useRef<Set<number>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const connRef = useRef<ConnState>("connecting");
  const streamUrl = `/api/townhall/chat/${encodeURIComponent(room)}/stream`;

  const setConnState = useCallback((c: ConnState) => {
    connRef.current = c;
    setConn(c);
  }, []);

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

  useEffect(() => {
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    // Polling fallback: short-lived fetch against the SSE endpoint every
    // 5s, parsing whatever `data:` lines arrive. (There is no separate
    // history endpoint in the API contract, so the stream itself is the
    // poll target.)
    const pollOnce = async () => {
      const ctrl = new AbortController();
      const killer = setTimeout(() => ctrl.abort(), 4500);
      try {
        const res = await fetch(streamUrl, {
          headers: { accept: "text/event-stream" },
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (!cancelled) addMessages(parseSseChunk(text));
      } catch {
        // Try again on the next tick.
      } finally {
        clearTimeout(killer);
      }
    };

    const startPolling = () => {
      if (cancelled || pollTimer) return;
      setConnState("polling");
      pollOnce();
      pollTimer = setInterval(pollOnce, 5000);
    };

    try {
      es = new EventSource(streamUrl);
      es.onopen = () => {
        if (!cancelled) setConnState("live");
      };
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as ChatMessage;
          if (msg && typeof msg.seq === "number") addMessages([msg]);
        } catch {
          // ignore malformed frames
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (!cancelled) startPolling();
      };
    } catch {
      startPolling();
    }

    // Safety net: if EventSource never opens within 6s, fall back to polling.
    const watchdog = setTimeout(() => {
      if (!cancelled && connRef.current === "connecting") {
        es?.close();
        es = null;
        startPolling();
      }
    }, 6000);

    return () => {
      cancelled = true;
      clearTimeout(watchdog);
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl, setConnState]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const send = async () => {
    const text = body.trim();
    if (!text || !canWrite) return;
    const ok = await dust.execute(async (dustFeeTxId) => {
      await postJson<{ seq: number }>(streamUrl.replace(/\/stream$/, ""), {
        author: me,
        body: text,
        dustFeeTxId,
      });
    });
    if (ok) setBody("");
    // The message arrives back through the stream; no manual append needed.
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
            disabled={!body.trim() || !canWrite || dust.phase.kind === "working" || dust.phase.kind === "paying"}
          >
            {dust.phase.kind === "working" || dust.phase.kind === "paying" ? "…" : "Send"}
          </button>
        </div>
        {!canWrite && <p className="th-muted" style={{ marginTop: 8 }}>{isAuthenticated ? "You need a page username to chat." : "Sign in with your wallet to chat."}</p>}
        <DustFeeGate flow={dust} actionLabel="message" />
      </div>
    </>
  );
}
