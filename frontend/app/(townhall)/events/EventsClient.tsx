"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWriteGate } from "@/components/townhall/useTownhall";
import { useHcsSubmit } from "@/components/townhall/useHcsSubmit";
import { getJson, postJson, timeAgo, makeTownhallId, type TownhallEvent } from "@/lib/townhall";

function formatStart(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The REST API passes startsAt through from the HCS message, which carries
 * an ISO-8601 string; the client type is epoch ms. Normalize once at the
 * boundary so sorting and filtering behave.
 */
function normalizeEvent(e: TownhallEvent): TownhallEvent {
  const s = (e as unknown as { startsAt: unknown }).startsAt;
  return {
    ...e,
    startsAt: typeof s === "string" ? Date.parse(s) : typeof s === "number" ? s : 0,
  };
}

/**
 * Event creation is moderator-only and enforced server-side; the form is
 * shown anyway so mods can use it, and anyone else gets the server's
 * rejection explained plainly.
 */
function NewEventForm({ onCreated }: { onCreated: () => void }) {
  const { username: me, canWrite, isAuthenticated } = useWriteGate();
  const hcs = useHcsSubmit();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const submit = async () => {
    setError(null);
    if (!title.trim() || !startsAt || !canWrite || !me) return;
    const ts = new Date(startsAt).getTime();
    if (!Number.isFinite(ts)) return;
    const t = title.trim();
    const d = description.trim();
    const startsIso = new Date(ts).toISOString();
    const id = makeTownhallId(t);
    setBusy(true);
    try {
      // Submit the event via the user's wallet, then notify the server
      // (it verifies the HCS tx via mirror node).
      const hcsTxId = await hcs.submit("governance", {
        v: 1,
        kind: "event",
        ts: new Date().toISOString(),
        author: me,
        id,
        title: t,
        description: d,
        startsAt: startsIso,
        room: `event-${id}`,
      });
      if (!hcsTxId) return; // User cancelled or error — phase shows the error
      await postJson("/api/townhall/events", {
        author: me,
        id,
        title: t,
        description: d,
        startsAt: startsIso,
        hcsTxId,
      });
      setTitle("");
      setDescription("");
      setStartsAt("");
      setOpen(false);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={() => setOpen(true)}>
        + Schedule event <span className="th-muted">(mods)</span>
      </button>
    );
  }

  return (
    <div className="th-card">
      <h3>Schedule a town-hall event</h3>
      <div className="th-form">
        <div>
          <label className="vs-label" htmlFor="ev-title">Title</label>
          <input
            id="ev-title"
            className="vs-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Weekly town hall"
            maxLength={120}
          />
        </div>
        <div>
          <label className="vs-label" htmlFor="ev-desc">Description</label>
          <textarea
            id="ev-desc"
            className="vs-input th-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Agenda, guests…"
            rows={3}
          />
        </div>
        <div>
          <label className="vs-label" htmlFor="ev-starts">Starts at</label>
          <input
            id="ev-starts"
            className="vs-input"
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </div>
        <div className="th-row">
          <button
            type="button"
            className="vs-btn vs-btn-primary th-btn-sm"
            onClick={submit}
            disabled={busy || !title.trim() || !startsAt || !canWrite}
          >
            {busy ? "Scheduling…" : "Schedule"}
          </button>
          <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
        {!canWrite && <p className="th-muted">{isAuthenticated ? "Set your page username (top of the page) first." : "Sign in with your wallet first."}</p>}
        <p className="th-note">Event creation is moderator-only — the server enforces it. If you&apos;re not a mod, the request will be rejected.</p>
        {error && <p className="th-error">{error}</p>}
      </div>
    </div>
  );
}

export default function EventsClient() {
  const [events, setEvents] = useState<TownhallEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ events?: TownhallEvent[] }>("/api/townhall/events");
      const list = Array.isArray(data.events) ? data.events.map(normalizeEvent) : [];
      list.sort((a, b) => a.startsAt - b.startsAt);
      setEvents(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const now = Date.now();
  const upcoming = events.filter((e) => e.startsAt >= now);
  const past = events.filter((e) => e.startsAt < now).reverse();

  return (
    <>
      <div className="th-page-head">
        <h1>📅 Town-hall <span className="vs-gradient-text">Schedule</span></h1>
        <p>Upcoming gatherings and AMAs. Each event has a live chat room — join when it starts.</p>
      </div>

      <div className="th-section">
        <NewEventForm onCreated={load} />
      </div>

      {loading && <p className="th-muted">Loading events…</p>}
      {error && (
        <p className="th-error">
          Couldn&apos;t load events: {error}{" "}
          <button type="button" className="th-identity-link" onClick={load}>
            retry
          </button>
        </p>
      )}

      {!loading && !error && (
        <>
          {upcoming.length > 0 && (
            <div className="th-section">
              <h2 className="th-h2">Upcoming ({upcoming.length})</h2>
              {upcoming.map((e) => (
                <div key={e.id} className="th-card">
                  <div className="th-between">
                    <h3>{e.title}</h3>
                    <span className="th-countdown">{formatStart(e.startsAt)}</span>
                  </div>
                  {e.description && <p>{e.description}</p>}
                  <div className="th-row" style={{ marginTop: 10 }}>
                    <Link
                      href={`/chat/${encodeURIComponent(`event-${e.id}`)}`}
                      className="vs-btn vs-btn-primary th-btn-sm"
                    >
                      Join live room →
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
          {past.length > 0 && (
            <div className="th-section">
              <h2 className="th-h2">Past</h2>
              {past.map((e) => (
                <div key={e.id} className="th-card">
                  <h3>{e.title}</h3>
                  <p className="th-muted">
                    {formatStart(e.startsAt)} · {timeAgo(e.startsAt)}
                  </p>
                  {e.description && <p>{e.description}</p>}
                </div>
              ))}
            </div>
          )}
          {events.length === 0 && <p className="th-muted">No events scheduled yet.</p>}
        </>
      )}
    </>
  );
}
