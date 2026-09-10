"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getJson, type TownhallEvent } from "@/lib/townhall";

interface Room {
  id: string;
  title: string;
  description: string;
}

export default function ChatRoomsClient() {
  const [rooms, setRooms] = useState<Room[]>([
    { id: "lobby", title: "🏠 Lobby", description: "The always-open town square. Say hi." },
  ]);
  const [loadingEvents, setLoadingEvents] = useState(true);

  useEffect(() => {
    getJson<{ events?: TownhallEvent[] }>("/api/townhall/events")
      .then((d) => {
        const events = Array.isArray(d.events) ? d.events : [];
        const eventRooms: Room[] = events.map((e) => ({
          id: `event-${e.id}`,
          title: `🎤 ${e.title}`,
          description: e.description || `Live room for “${e.title}”.`,
        }));
        setRooms((prev) => [...prev, ...eventRooms]);
      })
      .catch(() => {
        // Events API unavailable — lobby still works.
      })
      .finally(() => setLoadingEvents(false));
  }, []);

  return (
    <>
      <div className="th-page-head">
        <h1>💬 Live <span className="vs-gradient-text">Chat</span></h1>
        <p>Real-time rooms over server-sent events. Messages cost the dust fee, same as forum posts.</p>
      </div>
      {rooms.map((r) => (
        <Link key={r.id} href={`/chat/${encodeURIComponent(r.id)}`} className="th-card th-card-link">
          <h3>{r.title}</h3>
          <p>{r.description}</p>
          <span className="th-identity-link">Join room →</span>
        </Link>
      ))}
      {loadingEvents && <p className="th-muted">Checking for event rooms…</p>}
    </>
  );
}
