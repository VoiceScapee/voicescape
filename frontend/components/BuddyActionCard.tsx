"use client";

/**
 * BuddyActionCard — the in-chat one-tap approval card for agent-initiated
 * on-chain actions. It lives inline in the chat thread, on the agent's
 * proposal message: the human never leaves the chat.
 *
 * Brandon's one-tap directive, applied to the bone: the card shows what the
 * action does (plain words), its cost, and ONE button. No multi-step
 * flows, no intermediate screens, no extra in-app confirmations. The agent
 * checks the wallet session + pairing liveness SILENTLY before firing
 * (see lib/prepared-tx); only a state the agent cannot fix itself surfaces —
 * no pairing, or a dead pairing — and then with a single repair action.
 * After the tap the agent submits, waits for the mirror-node receipt, and
 * posts the receipt + HashScan link back here. The human does nothing
 * after the one tap.
 *
 * HONEST CONSTRAINT (code comment, not user-facing copy): the wallet app
 * itself may show its own signature prompt when the request fires — that
 * is the wallet's security UI, not ours. Our UX is one tap; do not add
 * extra in-app confirmation screens around this component.
 */
import { useState } from "react";
import {
  hashscanTxUrl,
  NoWalletPairingError,
  OwnerMismatchError,
  StaleWalletPairingError,
  type PreparedTxPayload,
  type PreparedTxPhase,
  type SubmitPreparedTxResult,
} from "@/lib/prepared-tx";
import {
  STALE_CONNECTION_COPY,
  friendlyWalletError,
  requestWalletConnectUI,
} from "@/lib/wallet";

export interface BuddyActionCardProps {
  /** Short label, e.g. "Agent blockpage claim". */
  label: string;
  /** Card title, e.g. "Register @thechomps". */
  title: string;
  /** Plain-words summary of what the signature does. */
  summary: string;
  /** Cost copy, e.g. "Network gas only — a few cents of HBAR." */
  costEstimate: string;
  /** The frozen unsigned transaction the Approve tap submits. */
  payload: PreparedTxPayload;
  /**
   * Runs the whole post-tap pipeline (silent checks → sign → confirm).
   * Provided by the host (the chat widget binds the owner account).
   */
  onApprove: (payload: PreparedTxPayload) => Promise<SubmitPreparedTxResult>;
  /** Called when the action settles, so the host can dismiss the inbox slot. */
  onSettled?: (result: SubmitPreparedTxResult) => void;
}

type CardState =
  | { kind: "idle" }
  | { kind: "working"; phase: PreparedTxPhase }
  | { kind: "needs-pairing" }
  | { kind: "stale" }
  | { kind: "done"; txId: string; confirmed: boolean }
  | { kind: "error"; message: string };

const PHASE_COPY: Record<PreparedTxPhase, string> = {
  checking: "Checking your wallet…",
  signing: "Check your wallet to sign…",
  confirming: "Confirming on Hedera…",
};

const BTN: React.CSSProperties = {
  width: "100%",
  padding: "11px 14px",
  borderRadius: 10,
  border: "none",
  cursor: "pointer",
  fontWeight: 800,
  fontSize: 15,
  color: "#fff",
  background: "linear-gradient(135deg, #8259ef, #b45cf0)",
};

const BTN_QUIET: React.CSSProperties = {
  ...BTN,
  background: "rgba(130, 89, 239, 0.18)",
  border: "1px solid rgba(130, 89, 239, 0.4)",
};

export default function BuddyActionCard({
  label,
  title,
  summary,
  costEstimate,
  payload,
  onApprove,
  onSettled,
}: BuddyActionCardProps) {
  const [state, setState] = useState<CardState>({ kind: "idle" });

  async function approve() {
    setState({ kind: "working", phase: "checking" });
    try {
      const result = await onApprove(payload);
      setState({ kind: "done", txId: result.txId, confirmed: result.confirmed });
      onSettled?.(result);
    } catch (e) {
      if (e instanceof NoWalletPairingError) {
        setState({ kind: "needs-pairing" });
      } else if (e instanceof StaleWalletPairingError) {
        setState({ kind: "stale" });
      } else if (e instanceof OwnerMismatchError) {
        setState({ kind: "error", message: e.message });
      } else {
        // User dismissed at the wallet, wallet refused, tx failed on-chain,
        // or a network blip — honest copy, retry is a deliberate re-tap.
        setState({ kind: "error", message: friendlyWalletError(e) });
      }
    }
  }

  function openWalletUI() {
    // The agent can't re-pair a dead/missing pairing itself — one tap opens
    // the standard wallet pairing UI; the user then taps Approve again.
    requestWalletConnectUI();
    setState({ kind: "idle" });
  }

  const working = state.kind === "working";

  return (
    <div
      style={{
        border: "1px solid rgba(130, 89, 239, 0.35)",
        borderRadius: 12,
        padding: "12px 14px",
        marginTop: 8,
        background: "rgba(130, 89, 239, 0.08)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "#b45cf0",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13.5, lineHeight: 1.55, opacity: 0.92 }}>{summary}</div>
      <div style={{ fontSize: 12.5, marginTop: 8, opacity: 0.75 }}>
        Cost: {costEstimate}
      </div>

      {state.kind === "idle" && (
        <button type="button" onClick={() => void approve()} style={{ ...BTN, marginTop: 12 }}>
          Approve
        </button>
      )}

      {working && (
        <button type="button" disabled style={{ ...BTN_QUIET, marginTop: 12, opacity: 0.85, cursor: "default" }}>
          {PHASE_COPY[state.phase]}
        </button>
      )}

      {state.kind === "needs-pairing" && (
        <>
          <div style={{ fontSize: 13.5, marginTop: 10, lineHeight: 1.55 }}>
            No wallet connected — connect it to approve.
          </div>
          <button type="button" onClick={openWalletUI} style={{ ...BTN, marginTop: 10 }}>
            Connect wallet
          </button>
        </>
      )}

      {state.kind === "stale" && (
        <>
          <div style={{ fontSize: 13.5, marginTop: 10, lineHeight: 1.55 }}>
            {STALE_CONNECTION_COPY}
          </div>
          <button type="button" onClick={openWalletUI} style={{ ...BTN, marginTop: 10 }}>
            Reconnect wallet
          </button>
        </>
      )}

      {state.kind === "done" && state.confirmed && (
        <div style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.6 }}>
          <div style={{ fontWeight: 700 }}>✅ Approved &amp; confirmed on Hedera</div>
          <div style={{ fontFamily: "monospace", fontSize: 12, marginTop: 6, wordBreak: "break-all", opacity: 0.85 }}>
            {state.txId}
          </div>
          <a
            href={hashscanTxUrl(state.txId)}
            target="_blank"
            rel="noreferrer"
            style={{ color: "#b45cf0", fontWeight: 700 }}
          >
            View on HashScan →
          </a>
        </div>
      )}

      {state.kind === "done" && !state.confirmed && (
        <>
          <div style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 700 }}>⚠️ Submitted, but not confirmed yet</div>
            <div style={{ marginTop: 4, opacity: 0.85 }}>
              Check HashScan before retrying — the transaction may still land.
            </div>
            <a
              href={hashscanTxUrl(state.txId)}
              target="_blank"
              rel="noreferrer"
              style={{ color: "#b45cf0", fontWeight: 700 }}
            >
              Check on HashScan →
            </a>
          </div>
          <button
            type="button"
            onClick={() => setState({ kind: "idle" })}
            style={{ ...BTN_QUIET, marginTop: 10 }}
          >
            Try again
          </button>
        </>
      )}

      {state.kind === "error" && (
        <>
          <div style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.6, color: "#ff9d9d" }}>
            {state.message}
          </div>
          <button
            type="button"
            onClick={() => setState({ kind: "idle" })}
            style={{ ...BTN_QUIET, marginTop: 10 }}
          >
            Try again
          </button>
        </>
      )}
    </div>
  );
}
