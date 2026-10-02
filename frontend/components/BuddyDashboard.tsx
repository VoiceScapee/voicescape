"use client";

/**
 * BuddyDashboard — the owner's mission control for their AI agent's
 * blockpage, pinned inside the Buddy chat. First-principles minimal, per
 * Brandon's spec: status, activity, approvals. Nothing else — no heavy
 * analytics, no decorative widgets.
 *
 *   Status   — agent username, on-chain registration confirmed
 *              (lookup_blockpage), profile actually loading
 *              (check_profile_pin).
 *   Activity — recent tips to the agent's page, on-chain only
 *              (TipSent logs via the mirror node).
 *   Proposals — the agent's pending actions, each with its inline one-tap
 *              approve (the same BuddyActionCard as the thread).
 *
 * Every figure is live Hedera mainnet data. Quiet honest states when
 * there's nothing happening ("No tips yet", "Nothing waiting on you") —
 * never simulated, never decorative. Rendered only when the signed-in
 * wallet owns an agent blockpage; everyone else sees an unchanged chat.
 */
import { useState } from "react";
import BuddyActionCard from "./BuddyActionCard";
import type { AgentOverview } from "@/lib/server/agent-overview";
import type { PendingAction } from "@/lib/server/pending-actions";
import type { SubmitPreparedTxResult } from "@/lib/prepared-tx";

export interface BuddyDashboardProps {
  overview: AgentOverview;
  proposals: PendingAction[];
  onApprove: (action: PendingAction) => Promise<SubmitPreparedTxResult>;
  onProposalSettled: (id: string) => void;
}

function shortAddr(a: string): string {
  const t = a.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(t) ? `${t.slice(0, 6)}…${t.slice(-4)}` : t;
}

function timeAgo(ts: string): string {
  const sec = Number(String(ts).split(".")[0]);
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const mins = Math.max(0, Math.floor((Date.now() - sec * 1000) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtHbar(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4).replace(/\.?0+$/, "") : "0";
}

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  opacity: 0.6,
  margin: "12px 0 6px",
};

export default function BuddyDashboard({
  overview,
  proposals,
  onApprove,
  onProposalSettled,
}: BuddyDashboardProps) {
  const [open, setOpen] = useState(false);
  const status = overview.status;
  const tips = overview.activity.tips;
  const username = overview.username ?? "your agent";

  const statusDot = status?.registered ? "🟢" : "🟡";
  const waiting = proposals.length;

  return (
    <div
      style={{
        border: "1px solid rgba(130, 89, 239, 0.3)",
        borderRadius: 12,
        margin: "8px 12px 0",
        background: "rgba(130, 89, 239, 0.06)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "9px 12px",
          background: "none",
          border: "none",
          color: "#fff",
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 700,
          textAlign: "left",
        }}
      >
        <span aria-hidden>🎛</span>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          @{username} {statusDot}
          {waiting > 0 && (
            <span style={{ color: "#b45cf0" }}> · {waiting} waiting</span>
          )}
        </span>
        <span aria-hidden style={{ opacity: 0.6 }}>{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div style={{ padding: "0 12px 12px", fontSize: 13.5, lineHeight: 1.55 }}>
          <div style={SECTION_LABEL}>Status</div>
          <div>
            {status?.registered ? (
              <>✅ Registered on-chain <span style={{ opacity: 0.65 }}>({overview.ownerAccountId})</span></>
            ) : (
              <>🟡 Registration not confirmed on-chain</>
            )}
          </div>
          <div style={{ marginTop: 4 }}>
            {status?.profileReachable ? (
              <>✅ Profile loads</>
            ) : (
              <>🟡 Profile not loading right now</>
            )}
          </div>

          <div style={SECTION_LABEL}>Activity</div>
          {tips.length === 0 ? (
            <div style={{ opacity: 0.65 }}>No tips yet — quiet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {tips.map((t, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ fontWeight: 800, whiteSpace: "nowrap" }}>
                    {fmtHbar(t.amountHbar)} HBAR
                  </span>
                  <span style={{ opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    from {shortAddr(t.from)}
                  </span>
                  <span style={{ opacity: 0.5, fontSize: 12, whiteSpace: "nowrap" }}>
                    {timeAgo(t.timestamp)}
                  </span>
                  {t.txHash && (
                    <a
                      href={`https://hashscan.io/mainnet/transaction/${t.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "#b45cf0", fontWeight: 700, whiteSpace: "nowrap" }}
                    >
                      ↗
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={SECTION_LABEL}>Proposals</div>
          {waiting === 0 ? (
            <div style={{ opacity: 0.65 }}>Nothing waiting on you.</div>
          ) : (
            proposals.map((p) => (
              <BuddyActionCard
                key={p.id}
                label={p.label}
                title={p.title}
                summary={p.summary}
                costEstimate={p.costEstimate}
                action={p}
                onApprove={onApprove}
                onSettled={() => onProposalSettled(p.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
