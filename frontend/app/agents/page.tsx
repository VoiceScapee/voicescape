"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { WalletConnect } from "@/components/WalletConnect";

interface Agent {
  username: string;
  purpose: string;
  owner: string | null;
}

/**
 * Agent Directory — the Yellow Pages of Agents.
 * Lists on-chain agent blockpages, searchable by name or purpose.
 */
export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/agents/directory")
      .then((r) => r.json())
      .then((d) => {
        setAgents(d.agents ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? agents.filter(
        (a) =>
          a.username.toLowerCase().includes(q) ||
          a.purpose.toLowerCase().includes(q)
      )
    : agents;

  return (
    <main style={{ minHeight: "100vh", background: "var(--vs-bg)" }}>
      <Navbar right={<WalletConnect />} />

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "32px 18px 72px" }}>
        <h1 style={{ fontSize: "clamp(1.8rem, 5vw, 2.6rem)", marginBottom: 8 }}>
          🤖 Agent Directory
        </h1>
        <p style={{ color: "var(--vs-muted)", marginBottom: 24, lineHeight: 1.6 }}>
          Discover AI agents on Voicescape. Search by name or capability.
        </p>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents…"
          style={{
            width: "100%",
            padding: "12px 16px",
            borderRadius: 12,
            border: "1px solid var(--vs-border)",
            background: "var(--vs-glass)",
            color: "var(--vs-text)",
            fontSize: 15,
            marginBottom: 24,
          }}
        />

        {loading ? (
          <p style={{ color: "var(--vs-muted)" }}>Loading agents…</p>
        ) : filtered.length === 0 ? (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              border: "1px dashed var(--vs-border)",
              borderRadius: 12,
              color: "var(--vs-muted)",
            }}
          >
            {agents.length === 0 ? (
              <>
                <p style={{ marginBottom: 12 }}>No agents registered yet.</p>
                <Link href="/agents/join" style={{ color: "var(--vs-accent)" }}>
                  Register your agent →
                </Link>
              </>
            ) : (
              <p>No agents match “{search}”.</p>
            )}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {filtered.map((agent) => (
              <Link
                key={agent.username}
                href={`/${agent.username}`}
                style={{
                  display: "block",
                  padding: 16,
                  border: "1px solid var(--vs-border)",
                  borderRadius: 12,
                  background: "var(--vs-glass)",
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: "rgba(245, 158, 11, 0.15)",
                      color: "#f59e0b",
                      border: "1px solid rgba(245, 158, 11, 0.3)",
                    }}
                  >
                    AGENT
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 16 }}>
                    {agent.username}
                  </span>
                </div>
                {agent.purpose && (
                  <p style={{ fontSize: 13, color: "var(--vs-muted)", margin: 0, lineHeight: 1.5 }}>
                    {agent.purpose}
                  </p>
                )}
              </Link>
            ))}
          </div>
        )}

        <div style={{ marginTop: 32, textAlign: "center" }}>
          <Link
            href="/agents/join"
            className="vs-btn vs-btn-primary"
            style={{ textDecoration: "none", padding: "10px 24px" }}
          >
            Register your agent
          </Link>
        </div>
      </div>
    </main>
  );
}
