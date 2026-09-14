"use client";

import { useEffect, useState } from "react";

type AgentSkill = {
  id: string;
  name: string;
  description: string;
  examples?: string[];
};

type AgentCardDoc = {
  name?: string;
  description?: string;
  version?: string;
  provider?: { organization?: string; url?: string };
  documentationUrl?: string;
  supportedInterfaces?: { url?: string; protocolBinding?: string; protocolVersion?: string }[];
  skills?: AgentSkill[];
};

const CARD_URL = "/.well-known/agent.json";

// danny's verified on-chain identity. Rendered from registry facts, never from
// editable page content — this panel only ever appears on the liaison's own
// blockpage.
const ACCOUNT_ID = "0.0.10857765";
const OWNER_TYPE = "AGENT";

export default function DannyAgentCard() {
  const [card, setCard] = useState<AgentCardDoc | null>(null);

  useEffect(() => {
    let live = true;
    fetch(CARD_URL, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (live && j && typeof j.name === "string") setCard(j as AgentCardDoc);
      })
      .catch(() => {
        /* Card unreachable — stay hidden; the quiet machine-readable link
           below the page still serves crawlers. */
      });
    return () => {
      live = false;
    };
  }, []);

  if (!card) return null;

  const endpoint = card.supportedInterfaces?.[0]?.url ?? "";
  const protocol = card.supportedInterfaces?.[0];
  const skills = card.skills ?? [];

  return (
    <section
      aria-label="danny's agent card"
      style={{
        border: "1px solid var(--vs-border, #2a2a35)",
        borderRadius: 14,
        padding: "16px 16px 12px",
        margin: "4px 0 20px",
        background: "var(--vs-card, rgba(255,255,255,0.02))",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: "#3ddc84",
            boxShadow: "0 0 8px #3ddc84",
            flexShrink: 0,
          }}
        />
        <div>
          <div style={{ fontWeight: 700, fontSize: "1.05rem", lineHeight: 1.2 }}>
            {card.name}
            <span style={{ fontWeight: 400, color: "var(--vs-muted)", fontSize: "0.85rem" }}>
              {" "}
              · agent card
            </span>
          </div>
          <div style={{ fontSize: "0.8rem", color: "var(--vs-muted)" }}>
            Voicescape&apos;s agent liaison — the machine-to-machine contact point for AI agents
          </div>
        </div>
      </div>

      {card.description && (
        <p style={{ fontSize: "0.85rem", lineHeight: 1.55, color: "var(--vs-muted)", margin: "0 0 12px" }}>
          {card.description}
        </p>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 8,
          marginBottom: 12,
        }}
      >
        {[
          { k: "Account", v: ACCOUNT_ID, mono: true },
          { k: "On-chain type", v: OWNER_TYPE },
          {
            k: "Protocol",
            v: protocol ? `${protocol.protocolBinding ?? "A2A"} v${protocol.protocolVersion ?? "1.0"}` : "A2A v1.0",
          },
        ].map((f) => (
          <div
            key={f.k}
            style={{
              background: "var(--vs-muted-bg, rgba(255,255,255,0.04))",
              borderRadius: 8,
              padding: "8px 10px",
            }}
          >
            <div
              style={{
                fontSize: "0.65rem",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--vs-muted)",
              }}
            >
              {f.k}
            </div>
            <div
              style={{
                fontWeight: 600,
                fontSize: "0.85rem",
                fontFamily: f.mono ? "monospace" : undefined,
              }}
            >
              {f.v}
            </div>
          </div>
        ))}
      </div>

      {skills.length > 0 && (
        <>
          <div
            style={{
              fontSize: "0.7rem",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--vs-muted)",
              marginBottom: 6,
            }}
          >
            What agents can ask
          </div>
          <ul style={{ margin: "0 0 12px", padding: 0, listStyle: "none" }}>
            {skills.map((s) => (
              <li key={s.id} style={{ fontSize: "0.85rem", marginBottom: 6, lineHeight: 1.45 }}>
                <span style={{ color: "var(--vs-accent)", fontWeight: 700, marginRight: 6 }}>›</span>
                <strong>{s.name}</strong>
                {s.examples && s.examples[0] && (
                  <span style={{ color: "var(--vs-muted)" }}> — “{s.examples[0]}”</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <div
        style={{
          borderTop: "1px solid var(--vs-border, #2a2a35)",
          paddingTop: 10,
          fontSize: "0.75rem",
          color: "var(--vs-muted)",
          display: "flex",
          flexWrap: "wrap",
          gap: "4px 12px",
          alignItems: "center",
        }}
      >
        {endpoint && (
          <span style={{ wordBreak: "break-all" }}>
            Endpoint: <span style={{ fontFamily: "monospace" }}>{endpoint}</span>
          </span>
        )}
        <span>Read-only — never moves funds.</span>
        <a href={CARD_URL} style={{ color: "var(--vs-accent)" }}>
          Raw JSON
        </a>
      </div>
    </section>
  );
}
