"use client";

/**
 * Live chat preview — the town-hall lobby, surfaced on the landing page
 * instead of hidden away. Read-only: latest lobby messages, auto-refreshing,
 * with a "join the conversation" CTA into /chat.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { T } from "@/components/T";
import { IconArrowRight } from "@/components/icons";

interface ChatMsg {
  seq: number;
  author: string;
  body: string;
  ts: number;
}

function shortAuthor(a: string): string {
  if (!a) return "?";
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function ChatPreview() {
  const [msgs, setMsgs] = useState<ChatMsg[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/townhall/chat/lobby", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { messages?: ChatMsg[] };
        if (alive && Array.isArray(json.messages)) {
          setMsgs(json.messages.slice(-6));
        }
      } catch {
        /* preview stays hidden on failure */
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Nothing to show yet (or chat unreachable) — hide, don't show an empty box.
  if (!msgs || msgs.length === 0) return null;

  return (
    <section className="vs-section" style={{ paddingTop: 0 }}>
      <div className="vs-card">
        <p className="vs-label" style={{ marginBottom: 8 }}>
          <span className="vs-live-dot" aria-hidden="true" /> <T k="landing.chatLabel" />
        </p>
        <h2 style={{ fontSize: "clamp(1.3rem, 3.5vw, 1.8rem)", margin: "0 0 16px" }}>
          <T k="landing.chatTitle" />
        </h2>
        <ul style={{ listStyle: "none", margin: "0 0 20px", padding: 0 }}>
          {msgs.map((m) => (
            <li
              key={m.seq}
              style={{
                padding: "10px 0",
                borderTop: "1px solid var(--vs-border)",
                fontSize: 15,
                lineHeight: 1.6,
              }}
            >
              <span style={{ color: "var(--vs-cyan)", fontWeight: 600 }}>
                {shortAuthor(m.author)}
              </span>
              <span style={{ color: "var(--vs-muted)" }}> · </span>
              <span>{m.body}</span>
            </li>
          ))}
        </ul>
        <Link
          href="/chat"
          className="vs-btn vs-btn-primary"
          style={{ textDecoration: "none", fontSize: 15 }}
        >
          <T k="landing.chatCta" />
          <IconArrowRight size={18} />
        </Link>
      </div>
    </section>
  );
}
