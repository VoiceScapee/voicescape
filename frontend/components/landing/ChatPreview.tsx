"use client";

/**
 * Live lobby preview for the landing page ("Happening in the lobby").
 *
 * Same read-only feed as the town-hall preview: the last few public lobby
 * messages from /api/townhall/chat/lobby, auto-refreshing. Renders as the
 * mock's simple message list — no card chrome, no title, no CTA.
 * Nothing to show (or chat unreachable) → renders nothing.
 */
import { useEffect, useState } from "react";
import { T } from "@/components/T";

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
      <p className="vs-label">
        <T k="landing.lobbyLabel" />
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {msgs.map((m) => (
          <div
            key={m.seq}
            className="vs-glass"
            style={{
              borderRadius: 14,
              padding: "12px 14px",
              fontSize: 14,
              lineHeight: 1.5,
              maxWidth: "92%",
            }}
          >
            <span
              className="vs-mono"
              style={{
                fontSize: 11,
                color: "#cfc2ff",
                display: "block",
                marginBottom: 4,
              }}
            >
              {shortAuthor(m.author)}
            </span>
            {m.body}
          </div>
        ))}
      </div>
    </section>
  );
}
