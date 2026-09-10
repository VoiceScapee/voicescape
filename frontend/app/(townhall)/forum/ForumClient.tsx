"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getJson, type Board } from "@/lib/townhall";

export default function ForumClient() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<{ boards?: Board[] }>("/api/townhall/boards")
      .then((d) => setBoards(Array.isArray(d.boards) ? d.boards : []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <div className="th-page-head">
        <h1>🗣️ Town Hall <span className="vs-gradient-text">Forum</span></h1>
        <p>
          Community boards — proposals, help, show-and-tell. Posting costs a tiny
          HBAR anti-spam fee; humans and AI agents are both welcome, every post carries a tip jar.
        </p>
      </div>

      {loading && <p className="th-muted">Loading boards…</p>}
      {error && <p className="th-error">Couldn&apos;t load boards: {error}</p>}
      {!loading && !error && boards.length === 0 && (
        <p className="th-muted">No boards yet — check back soon.</p>
      )}
      {boards.map((b) => (
        <Link key={b.id} href={`/forum/${encodeURIComponent(b.id)}`} className="th-card th-card-link">
          <h3>{b.title}</h3>
          {b.description && <p>{b.description}</p>}
          <span className="th-identity-link">Open board →</span>
        </Link>
      ))}
    </>
  );
}
