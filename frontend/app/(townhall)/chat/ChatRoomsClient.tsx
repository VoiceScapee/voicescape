"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getJson, postJson, type TownhallEvent } from "@/lib/townhall";
import { useWriteGate } from "@/components/townhall/useTownhall";
import { useHcsSubmit } from "@/components/townhall/useHcsSubmit";

interface Room {
  id: string;
  title: string;
  description: string;
  creator: string;
  createdAt: string;
  gated?: boolean;
}

/** Derive a URL-safe room slug from a title (matches the server's CHATROOM_ID_RE). */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export default function ChatRoomsClient() {
  const { username: me, canWrite, isAuthenticated } = useWriteGate();
  const hcs = useHcsSubmit();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const loadRooms = useCallback(async () => {
    setLoading(true);
    try {
      // Custom + lobby rooms from the chat topic.
      const d = await getJson<{ rooms?: Room[] }>("/api/townhall/chat");
      const apiRooms = Array.isArray(d.rooms) ? d.rooms : [];
      // Event-derived rooms (separate feature, kept).
      let eventRooms: Room[] = [];
      try {
        const e = await getJson<{ events?: TownhallEvent[] }>("/api/townhall/events");
        const events = Array.isArray(e.events) ? e.events : [];
        eventRooms = events.map((ev) => ({
          id: `event-${ev.id}`,
          title: `🎤 ${ev.title}`,
          description: ev.description || `Live room for “${ev.title}”.`,
          creator: "voicescape",
          createdAt: "",
        }));
      } catch {
        // Events API unavailable — custom rooms still work.
      }
      const seen = new Set(apiRooms.map((r) => r.id));
      setRooms([...apiRooms, ...eventRooms.filter((r) => !seen.has(r.id))]);
    } catch {
      // Chat API unavailable — nothing to show.
      setRooms([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  const createRoom = async () => {
    setFormError(null);
    setCreated(null);
    const t = title.trim();
    const d = description.trim();
    if (t.length < 3 || t.length > 60) {
      setFormError("Title must be 3–60 characters.");
      return;
    }
    if (d.length > 200) {
      setFormError("Description must be 200 characters or fewer.");
      return;
    }
    const id = slugify(t);
    if (id.length < 3) {
      setFormError("That title can't make a room id — use letters or numbers.");
      return;
    }
    if (!me) {
      setFormError("Sign in and set your page username first.");
      return;
    }
    let newRoomId: string | null = null;
    // Submit the chatroom-create message via the user's wallet, then notify
    // the server (it verifies the HCS tx via mirror node).
    const hcsTxId = await hcs.submit("chat", {
      v: 1,
      kind: "chatroom-create",
      ts: new Date().toISOString(),
      author: me,
      id,
      title: t,
      description: d,
    });
    if (!hcsTxId) return; // User cancelled or error — phase shows the error
    try {
      const r = await postJson<{ roomId: string }>("/api/townhall/chat", {
        author: me,
        id,
        title: t,
        description: d,
        hcsTxId,
      });
      newRoomId = r.roomId;
    } catch (e) {
      // Server verification failed — the HCS tx is still on-chain, but the
      // server didn't accept it (e.g., content filter). Show the error.
      setFormError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (newRoomId) {
      setCreated(newRoomId);
      setTitle("");
      setDescription("");
      setShowForm(false);
      await loadRooms();
    }
  };

  const busy = hcs.phase.kind === "submitting";

  return (
    <>
      <div className="th-page-head">
        <h1>💬 Live <span className="vs-gradient-text">Chat</span></h1>
        <p>Real-time rooms over server-sent events. You sign each message in your wallet — transparent and on-chain.</p>
      </div>

      {canWrite && !showForm && (
        <button
          type="button"
          className="vs-btn vs-btn-primary"
          style={{ marginBottom: 16 }}
          onClick={() => setShowForm(true)}
        >
          ＋ Create a room
        </button>
      )}

      {showForm && (
        <div className="th-card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Create a chatroom</h3>
          <p className="th-muted" style={{ marginTop: 0 }}>
            Rooms are permanent and public. Your page name will show as the creator.
            {title.trim() && (
              <> Room id: <code className="vs-mono">#{slugify(title.trim()) || "…"}</code></>
            )}
          </p>
          <label className="vb-field">
            <span className="vs-label">Title (3–60 chars)</span>
            <input
              className="vs-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Agent coffee chat"
              maxLength={60}
              aria-label="Room title"
            />
          </label>
          <label className="vb-field">
            <span className="vs-label">Description (optional, max 200 chars)</span>
            <input
              className="vs-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this room for?"
              maxLength={200}
              aria-label="Room description"
            />
          </label>
          {formError && <p style={{ color: "#f87171", fontSize: 13 }}>{formError}</p>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="vs-btn vs-btn-primary"
              onClick={createRoom}
              disabled={busy || title.trim().length < 3}
            >
              {busy ? "Sign in wallet…" : "Create room"}
            </button>
            <button
              type="button"
              className="vs-btn vs-btn-ghost"
              onClick={() => {
                setShowForm(false);
                setFormError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
          {hcs.phase.kind === "error" && (
            <p className="th-error" style={{ marginTop: 8 }}>Failed to submit: {hcs.phase.message}</p>
          )}
        </div>
      )}

      {created && (
        <p style={{ color: "var(--vs-cyan)", fontSize: 14 }}>
          Room <Link href={`/chat/${encodeURIComponent(created)}`} className="th-identity-link">#{created}</Link> created — jump in!
        </p>
      )}

      {rooms.map((r) => (
        <Link key={r.id} href={`/chat/${encodeURIComponent(r.id)}`} className="th-card th-card-link">
          <h3>{r.title}{r.gated && <span title="Requires the Builder badge" style={{ marginLeft: 8 }}>🔒</span>}</h3>
          <p>{r.description}</p>
          <p className="th-muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
            by @{r.creator}
          </p>
          <span className="th-identity-link">Join room →</span>
        </Link>
      ))}
      {loading && <p className="th-muted">Loading rooms…</p>}
      {!loading && rooms.length === 0 && (
        <p className="th-muted">No rooms yet — be the first to create one.</p>
      )}
      {!canWrite && (
        <p className="th-muted" style={{ marginTop: 12 }}>
          {isAuthenticated
            ? "Set your page username (top of the page) to create rooms."
            : "Sign in with your wallet to create rooms."}
        </p>
      )}
    </>
  );
}
