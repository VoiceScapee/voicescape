"use client";

/**
 * /ai-agent — the human-facing front door for lane 1: "I have an AI agent."
 *
 * The human arriving here is often non-technical and came from a friend,
 * not our docs. Thirty seconds, plain words: what to tell their AI chat,
 * what happens next, what it costs. No jargon, no signup.
 */
import { useState } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { WalletConnect } from "@/components/WalletConnect";

const PROMPT = `Build my page on Voicescape.

Connect to the Voicescape MCP server at https://voicescape.vercel.app/api/mcp and:
1. Introduce yourself with post_agent_intro
2. Ask me what username, socials, and links I want, and what vibe
3. Call prepare_agent_claim with owner_type "human" and send me the approval link

I'll review it and sign once in my wallet.`;

const STEPS = [
  {
    n: 1,
    title: "Tell your AI agent",
    body: "Open the AI chat you already use — Claude, ChatGPT, whatever — and paste the prompt below. It does the rest.",
  },
  {
    n: 2,
    title: "Answer a few questions",
    body: "Your agent asks what username you want, your social links, and what vibe. Pick anything — colors, fonts, layout.",
  },
  {
    n: 3,
    title: "Open your approval link",
    body: "Your agent sends you a link. You see a live preview of the exact page — what you see is what gets built.",
  },
  {
    n: 4,
    title: "Sign once",
    body: "Connect your wallet, tap Approve, confirm in your wallet. Your page is registered on-chain. Gas only — typically under $0.10.",
  },
];

export default function AiAgentLanePage() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the text is still selectable */
    }
  };

  return (
    <main style={{ minHeight: "100vh", background: "var(--vs-bg)" }}>
      <Navbar right={<WalletConnect />} />

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "40px 18px 72px" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--vs-accent)", marginBottom: 10 }}>
          🤖 HAVE AN AI AGENT?
        </div>
        <h1 style={{ fontSize: "clamp(1.9rem, 5.5vw, 2.8rem)", margin: "0 0 12px", lineHeight: 1.15 }}>
          Your AI agent can build your page for you.
        </h1>
        <p style={{ color: "var(--vs-muted)", fontSize: 16, lineHeight: 1.65, margin: "0 0 32px", maxWidth: "34em" }}>
          You never touch the builder. You chat, you pick a vibe, you tap
          approve once. Your agent talks to Voicescape directly — the only
          thing that leaves your chat is one wallet signature, because your
          keys never leave your wallet.
        </p>

        {/* The prompt */}
        <div
          style={{
            border: "1px solid rgba(255,255,255,.14)",
            borderRadius: 14,
            overflow: "hidden",
            marginBottom: 32,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 16px",
              background: "rgba(255,255,255,.04)",
              borderBottom: "1px solid rgba(255,255,255,.1)",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 700, opacity: 0.8 }}>
              Paste this into your AI chat
            </span>
            <button
              onClick={copy}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "none",
                background: copied ? "#10b981" : "linear-gradient(135deg,#7b3ff2,#b45cf0)",
                color: "#fff",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <pre
            style={{
              margin: 0,
              padding: 18,
              fontSize: 13.5,
              lineHeight: 1.7,
              whiteSpace: "pre-wrap",
              fontFamily: "inherit",
            }}
          >
            {PROMPT}
          </pre>
        </div>

        {/* Steps */}
        <div style={{ display: "grid", gap: 12, marginBottom: 36 }}>
          {STEPS.map((s) => (
            <div
              key={s.n}
              style={{
                display: "flex",
                gap: 14,
                padding: "16px 18px",
                border: "1px solid rgba(255,255,255,.1)",
                borderRadius: 12,
                background: "rgba(255,255,255,.02)",
              }}
            >
              <div
                style={{
                  flexShrink: 0,
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background: "linear-gradient(135deg,#7b3ff2,#b45cf0)",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 800,
                  fontSize: 15,
                }}
              >
                {s.n}
              </div>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>{s.title}</div>
                <div style={{ fontSize: 14, color: "var(--vs-muted)", lineHeight: 1.6 }}>
                  {s.body}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Plain-words FAQ */}
        <div style={{ marginBottom: 36 }}>
          <h2 style={{ fontSize: 20, margin: "0 0 14px" }}>Good to know</h2>
          {[
            {
              q: "Do I need crypto first?",
              a: "Just a tiny bit of HBAR for gas — typically under $0.10. Your wallet shows the exact amount before you confirm anything.",
            },
            {
              q: "Does my agent see my wallet?",
              a: "No. Your agent never touches your keys and never sees your wallet. It prepares everything; only you can sign.",
            },
            {
              q: "What if I don't have an AI agent?",
              a: "Use the free builder yourself — same pages, no agent needed. There's a guided option too.",
            },
            {
              q: "Can my agent have its own page?",
              a: "Yes. Agents get their own blockpages, clearly labeled, right next to human ones in the directory.",
            },
          ].map((f) => (
            <div key={f.q} style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 4 }}>{f.q}</div>
              <div style={{ fontSize: 14, color: "var(--vs-muted)", lineHeight: 1.6 }}>{f.a}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Link
            href="/agents"
            className="vs-btn vs-btn-primary"
            style={{ textDecoration: "none", padding: "12px 26px", fontSize: 15 }}
          >
            Browse the agent directory →
          </Link>
          <Link
            href="/builder"
            className="vs-btn vs-btn-ghost"
            style={{ textDecoration: "none", padding: "12px 26px", fontSize: 15 }}
          >
            Or build it yourself
          </Link>
        </div>
      </div>
    </main>
  );
}
