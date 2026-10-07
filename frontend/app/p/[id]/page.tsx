"use client";

/**
 * /p/[id] — the proposal approval link a keyless agent drops in its OWN chat.
 *
 * Flow: Review → Approve → Connect → Done. The human reviews what the agent
 * proposed and taps Approve (intent — no wallet needed). Then they connect
 * a wallet, and the signature fires immediately on connect: one signature
 * and the page update is published. Pairing is the ONLY auth (no 7-day
 * session). The paired wallet MUST own the page — the server rejects
 * anything else. Connecting at the last moment keeps the wallet session
 * fresh for the signature.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { WalletConnect } from "@/components/WalletConnect";
import { getHederaPairing, requestWalletConnectUI, useWallet } from "@/lib/wallet";
import { reportError } from "@/lib/report-error";
import {
  submitPreparedTx,
  hashscanTxUrl,
  NoWalletPairingError,
  type PreparedTxPhase,
  type SubmitPreparedTxResult,
} from "@/lib/prepared-tx";
import {
  fetchUpdateSummary,
  finalizeUpdateProposal,
  UpdateLinkError,
  type UpdateSummary,
} from "@/lib/update-link";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "review" }
  // confirmed=false means the signature was submitted but the 2-minute
  // mirror window expired without a receipt — never claim "on-chain".
  | { kind: "done"; confirmed: boolean; txId: string };

export default function ProposalLinkPage() {
  const { id } = useParams<{ id: string }>();
  const { account: accountId } = useWallet();
  const [summary, setSummary] = useState<UpdateSummary | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // Approve-before-connect: the tap on "Approve" records intent (no wallet
  // needed). The wallet connects after, and the signature fires on connect.
  const [intentApproved, setIntentApproved] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  // Tracks the submit pipeline phase so copy stays honest: "check your
  // wallet" during signing, "waiting on the network" during mirror poll.
  const [txPhase, setTxPhase] = useState<PreparedTxPhase | null>(null);
  const signStarted = useRef(false);

  useEffect(() => {
    let live = true;
    fetchUpdateSummary(id)
      .then((s) => {
        if (!live) return;
        setSummary(s);
        setPhase({ kind: "review" });
      })
      .catch((e) => {
        if (!live) return;
        setPhase({
          kind: "error",
          message: e instanceof UpdateLinkError ? e.message : "Couldn't load this proposal.",
        });
      });
    return () => {
      live = false;
    };
  }, [id]);

  // One-tap approve: finalize (pin the proposed page + build the frozen
  // updatePage tx with the ACTUALLY CONNECTED account as payer — the server
  // rejects any wallet that doesn't own the page) then the whole post-tap
  // pipeline in submitPreparedTx — the human's only action is this tap plus
  // the wallet's own confirmation screen.
  const approve = useCallback(async (): Promise<SubmitPreparedTxResult> => {
    const pairing = getHederaPairing();
    const paired = pairing?.accountId;
    if (!paired) throw new NoWalletPairingError("Connect your wallet first.");
    const fin = await finalizeUpdateProposal(id, paired).catch((e) => {
      reportError(e, "proposal-approve", { action: "finalize-update", walletState: "connected" });
      throw new Error(
        e instanceof UpdateLinkError ? e.message : "Couldn't prepare the transaction — try again in a moment.",
      );
    });
    return submitPreparedTx(
      {
        transactionList: fin.unsignedTxBytes,
        signerAccountId: fin.signerAccountId,
        transactionId: fin.transactionId,
      },
      {
        restoreIfMissing: true,
        expectedOwnerAccountId: fin.owner_account_id,
        onPhase: setTxPhase,
      },
    );
  }, [id]);

  const onSettled = useCallback((result: SubmitPreparedTxResult) => {
    // confirmed=false is NOT success: the signature was submitted but the
    // 2-minute mirror window expired without a receipt. The done UI branches
    // on this — never claim "on-chain" without confirmation.
    setPhase({ kind: "done", confirmed: result.confirmed, txId: result.txId });
  }, []);

  // Approve-before-connect: once the human has tapped Approve (intent) and
  // a wallet is paired, fire the signature immediately. One ceremony:
  // connect → sign → done. Guarded so it runs exactly once.
  useEffect(() => {
    if (!intentApproved || !accountId || signStarted.current) return;
    if (phase.kind !== "review") return;
    signStarted.current = true;
    setSigning(true);
    setTxPhase(null);
    setSignError(null);
    approve()
      .then((result) => onSettled(result))
      .catch((e) => {
        signStarted.current = false;
        setSigning(false);
        setTxPhase(null);
        const message =
          e instanceof NoWalletPairingError
            ? "Wallet disconnected — reconnect and try again."
            : e instanceof Error
              ? e.message
              : "Couldn't complete the signature — try again.";
        setSignError(message);
        reportError(e, "proposal-approve", { action: "approve-after-connect", walletState: "connected" });
      });
  }, [intentApproved, accountId, approve, onSettled, phase.kind]);

  const retry = useCallback(() => {
    setSignError(null);
    signStarted.current = false;
    if (!accountId) {
      requestWalletConnectUI();
      return;
    }
    // Wallet is paired but the sign failed — retry the ceremony.
    signStarted.current = true;
    setSigning(true);
    setTxPhase(null);
    approve()
      .then((result) => onSettled(result))
      .catch((e) => {
        signStarted.current = false;
        setSigning(false);
        setTxPhase(null);
        setSignError(e instanceof Error ? e.message : "Couldn't complete the signature — try again.");
      });
  }, [accountId, approve, onSettled]);

  const expiresSoon =
    summary && Date.now() > new Date(summary.expires_at).getTime() - 2 * 3_600_000;

  return (
    <main
      style={{
        maxWidth: 560,
        margin: "0 auto",
        padding: "32px 20px 64px",
        color: "#f2ecff",
      }}
    >
      {/* The wallet connects AFTER approve (Review → Approve → Connect →
          Done) — showing the connect widget before the human has decided
          invites connect-first and contradicts the order. */}
      {intentApproved && <WalletConnect />}
      <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>
        Voicescape · Page update approval
      </div>

      {phase.kind === "loading" && <p>Loading the proposal…</p>}

      {phase.kind === "error" && (
        <div style={{ border: "1px solid rgba(255,120,120,.4)", borderRadius: 12, padding: "16px 18px", background: "rgba(255,80,80,.06)" }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>This link didn't work</div>
          <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>{phase.message}</div>
        </div>
      )}

      {(phase.kind === "review" || phase.kind === "done") && summary && (
        <>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 4px" }}>
            Update @{summary.username}
          </h1>
          <p style={{ margin: "0 0 16px", opacity: 0.75, fontSize: 14, lineHeight: 1.6 }}>
            Your AI agent proposed an update to this blockpage. Review it, tap
            Approve, then connect the wallet that owns the page to sign — one
            signature and the update is published.
          </p>

          {/* What-happens-next stepper */}
          <div style={{ display: "flex", gap: 0, marginBottom: 18 }} aria-label="Steps">
            {[
              { n: 1, label: "Review", done: true },
              { n: 2, label: "Approve", done: intentApproved },
              { n: 3, label: "Connect", done: intentApproved && (!!accountId || signing || phase.kind === "done") },
              { n: 4, label: "Done", done: phase.kind === "done" },
            ].map((s, i, arr) => (
              <div key={s.n} style={{ flex: 1, display: "flex", alignItems: "center" }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 13,
                      fontWeight: 800,
                      background: s.done ? "linear-gradient(135deg,#7b3ff2,#b45cf0)" : "rgba(255,255,255,.08)",
                      color: s.done ? "#fff" : "rgba(255,255,255,.55)",
                      border: s.done ? "none" : "1px solid rgba(255,255,255,.18)",
                    }}
                  >
                    {s.done ? "✓" : s.n}
                  </div>
                  <div style={{ fontSize: 11, opacity: s.done ? 0.95 : 0.55, fontWeight: s.done ? 700 : 400 }}>
                    {s.label}
                  </div>
                </div>
                {i < arr.length - 1 && (
                  <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,.15)", margin: "0 4px 16px" }} />
                )}
              </div>
            ))}
          </div>

          <div
            style={{
              border: "1px solid rgba(255,255,255,.14)",
              borderRadius: 12,
              padding: "14px 16px",
              marginBottom: 12,
              fontSize: 14,
              lineHeight: 1.65,
            }}
          >
            <div>
              <strong>What changed:</strong> {summary.change_summary}
            </div>
            <div style={{ marginTop: 6 }}>
              <strong>Display name:</strong> {summary.display_name}
            </div>
            {summary.purpose && (
              <div style={{ marginTop: 6 }}>
                <strong>Purpose:</strong> {summary.purpose}
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              <strong>Owner:</strong> {summary.owner_account_id} — connect this
              wallet to approve
            </div>
            <div style={{ marginTop: 6 }}>
              <strong>Cost:</strong> {summary.cost_estimate}
            </div>
            {expiresSoon && (
              <div style={{ marginTop: 6, color: "#ffb86b" }}>
                <strong>Expiring soon</strong> — untapped proposals expire 24h after the agent sends them.
              </div>
            )}
          </div>

          {phase.kind === "review" && !intentApproved && (
            <button
              onClick={() => setIntentApproved(true)}
              style={{
                width: "100%",
                padding: "14px",
                borderRadius: 12,
                border: "none",
                background: "linear-gradient(135deg,#7b3ff2,#b45cf0)",
                color: "white",
                fontSize: 16,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Approve update @{summary.username}
            </button>
          )}

          {phase.kind === "review" && intentApproved && !accountId && !signing && (
            <>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, opacity: 0.8, margin: "0 0 10px" }}>
                Approved ✓ — now connect the wallet that owns @{summary.username}.
                The signature fires right after you connect; one confirmation
                and the update is published.
              </p>
              <button
                onClick={requestWalletConnectUI}
                style={{
                  width: "100%",
                  padding: "14px",
                  borderRadius: 12,
                  border: "none",
                  background: "linear-gradient(135deg,#7b3ff2,#b45cf0)",
                  color: "white",
                  fontSize: 16,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                Connect wallet to sign
              </button>
            </>
          )}

          {phase.kind === "review" && intentApproved && signing && (
            <div
              style={{
                width: "100%",
                padding: "14px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,.14)",
                background: "rgba(255,255,255,.06)",
                color: "white",
                fontSize: 15,
                fontWeight: 700,
                textAlign: "center",
              }}
            >
              {txPhase === "confirming"
                ? `Signature sent — waiting for the network to confirm the update…`
                : `Check your wallet — confirm the signature to publish the update…`}
            </div>
          )}

          {phase.kind === "review" && signError && (
            <div style={{ border: "1px solid rgba(255,120,120,.4)", borderRadius: 12, padding: "12px 14px", background: "rgba(255,80,80,.06)", marginTop: 10 }}>
              <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>{signError}</div>
              <button
                onClick={retry}
                style={{
                  marginTop: 10,
                  width: "100%",
                  padding: "12px",
                  borderRadius: 10,
                  border: "none",
                  background: "linear-gradient(135deg,#7b3ff2,#b45cf0)",
                  color: "white",
                  fontSize: 15,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                {!accountId ? "Reconnect wallet" : "Try signing again"}
              </button>
            </div>
          )}

          {phase.kind === "done" && (
            <div style={{ border: "1px solid rgba(120,255,170,.35)", borderRadius: 12, padding: "16px 18px", background: "rgba(80,255,150,.06)" }}>
              {phase.confirmed ? (
                <>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>Updated 🎉</div>
                  <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>
                    The update to @{summary.username} is now on-chain.
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>Signature submitted — waiting on the network</div>
                  <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>
                    Your signature went through, but we couldn't confirm it
                    on-chain within 2 minutes. It may still land — check the
                    transaction below. If it never confirms, it's safe to try
                    again; nothing was published.
                  </div>
                </>
              )}
              {phase.txId && (
                <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6 }}>
                  <div style={{ opacity: 0.65, fontSize: 12, marginBottom: 2 }}>Transaction</div>
                  <a
                    href={hashscanTxUrl(phase.txId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "#b45cf0", fontWeight: 700, wordBreak: "break-all" }}
                  >
                    {phase.txId} ↗
                  </a>
                  <div style={{ opacity: 0.55, fontSize: 12, marginTop: 2 }}>
                    Verify it yourself on HashScan
                  </div>
                </div>
              )}
              {phase.confirmed && (
                <a
                  href={`/${summary.username}`}
                  style={{ display: "inline-block", marginTop: 10, color: "#b45cf0", fontSize: 14, fontWeight: 700 }}
                >
                  View the blockpage →
                </a>
              )}
            </div>
          )}

          <p style={{ fontSize: 12.5, opacity: 0.55, marginTop: 18, lineHeight: 1.6 }}>
            No signup, no sign-in. Tapping Approve is your go-ahead — nothing
            is recorded or signed until you connect the owning wallet and
            confirm in the wallet's own screen. One signature publishes the
            update — done.
          </p>
        </>
      )}
    </main>
  );
}
