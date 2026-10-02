"use client";

/**
 * /v/[id] — the vault setup link. An agent drops this in its owner's chat.
 *
 * No signup, no sign-in — pairing the wallet IS the approval. The human
 * reviews the plain-words summary, connects a wallet, reads the consent
 * box, and taps once. The tap prepares the unsigned vault-creation
 * transaction with the paired wallet as payer, submits it through the
 * wallet's own confirmation screen, then finalizes (server verifies the
 * on-chain key, registers the watch, burns the single-use link).
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { WalletConnect } from "@/components/WalletConnect";
import { requestWalletConnectUI, useWallet } from "@/lib/wallet";
import { reportError } from "@/lib/report-error";
import { submitPreparedTx, type SubmitPreparedTxResult } from "@/lib/prepared-tx";
import {
  fetchVaultSummary,
  prepareVaultSetup,
  finalizeVaultSetup,
  vaultIdFromSetupTx,
  VaultLinkError,
  type VaultSummary,
} from "@/lib/vault-link";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "review" }
  | { kind: "working"; message: string }
  | { kind: "done"; vaultId: string; hashscanUrl: string; setupHashscanUrl: string | null; agentUsername: string };

const shell: React.CSSProperties = {
  maxWidth: 480,
  margin: "0 auto",
  padding: "32px 20px 64px",
  color: "#f2ecff",
};

const eyebrow: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  opacity: 0.6,
  marginBottom: 8,
};

const card: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,.14)",
  borderRadius: 12,
  padding: "14px 16px",
  marginBottom: 12,
  fontSize: 15,
  lineHeight: 1.65,
};

const primaryButton: React.CSSProperties = {
  width: "100%",
  padding: "16px",
  borderRadius: 12,
  border: "none",
  background: "linear-gradient(135deg,#7b3ff2,#b45cf0)",
  color: "white",
  fontSize: 17,
  fontWeight: 800,
  cursor: "pointer",
};

export default function VaultSetupPage() {
  const { id } = useParams<{ id: string }>();
  const { account: accountId } = useWallet();
  const [summary, setSummary] = useState<VaultSummary | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const load = useCallback(() => {
    setPhase({ kind: "loading" });
    fetchVaultSummary(id)
      .then((s) => {
        setSummary(s);
        setPhase({ kind: "review" });
      })
      .catch((e) => {
        reportError(e, "vault-setup", {
          action: "load-link",
          walletState: accountId ? "connected" : "disconnected",
        });
        setPhase({
          kind: "error",
          message: e instanceof VaultLinkError ? e.message : "Couldn't load this setup link.",
        });
      });
  }, [id, accountId]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const s = await fetchVaultSummary(id);
        if (!cancelled) {
          setSummary(s);
          setPhase({ kind: "review" });
        }
      } catch (e) {
        if (!cancelled) {
          reportError(e, "vault-setup", {
            action: "load-link",
            walletState: accountId ? "connected" : "disconnected",
          });
          setPhase({
            kind: "error",
            message: e instanceof VaultLinkError ? e.message : "Couldn't load this setup link.",
          });
        }
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [id, accountId]);

  const approve = useCallback(async () => {
    if (!accountId) return;
    setPhase({ kind: "working", message: "Preparing the transaction…" });
    try {
      const prepared = await prepareVaultSetup(id, accountId);
      setPhase({ kind: "working", message: "Waiting for your wallet — confirm in the wallet app…" });
      const result: SubmitPreparedTxResult = await submitPreparedTx(
        {
          transactionList: prepared.unsigned_tx_bytes,
          signerAccountId: accountId,
          transactionId: prepared.transaction_id,
        },
        { restoreIfMissing: true },
      );
      setPhase({ kind: "working", message: "Confirming on Hedera…" });
      const vaultId = await vaultIdFromSetupTx(result.txId);
      if (!vaultId) {
        throw new VaultLinkError(
          "The transaction went through but we couldn't read the new account yet — check HashScan, then refresh this page.",
        );
      }
      const fin = await finalizeVaultSetup(id, vaultId, accountId, result.txId);
      setPhase({
        kind: "done",
        vaultId: fin.vault_account_id,
        hashscanUrl: fin.hashscan_url,
        setupHashscanUrl: fin.setup_tx_hashscan_url,
        agentUsername: fin.agent_username,
      });
    } catch (e) {
      reportError(e, "vault-setup", { action: "create-vault", walletState: "connected" });
      setPhase({
        kind: "error",
        message:
          e instanceof VaultLinkError
            ? e.message
            : e instanceof Error
              ? e.message
              : "Something went wrong — try again in a moment.",
      });
    }
  }, [id, accountId]);

  const usdNote = summary
    ? `~$${summary.cost_breakdown.total_usd.toFixed(2)}`
    : null;

  return (
    <main style={shell}>
      <WalletConnect />
      <div style={eyebrow}>Voicescape · Agent vault setup</div>

      {phase.kind === "loading" && (
        <p style={{ fontSize: 15, lineHeight: 1.6, opacity: 0.85 }}>
          Loading the setup…
        </p>
      )}

      {phase.kind === "error" && (
        <div
          style={{
            border: "1px solid rgba(255,120,120,.4)",
            borderRadius: 12,
            padding: "16px 18px",
            background: "rgba(255,80,80,.06)",
          }}
        >
          <div style={{ fontWeight: 800, marginBottom: 6 }}>This link didn't work</div>
          <div style={{ fontSize: 15, lineHeight: 1.6, opacity: 0.9 }}>{phase.message}</div>
          <button
            onClick={load}
            style={{ ...primaryButton, marginTop: 14, background: "rgba(255,255,255,.12)" }}
          >
            Try again
          </button>
        </div>
      )}

      {phase.kind === "working" && (
        <p style={{ fontSize: 15, lineHeight: 1.6, opacity: 0.85 }}>{phase.message}</p>
      )}

      {(phase.kind === "review" || phase.kind === "working") && summary && (
        <>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 4px" }}>
            Give @{summary.agent_username} its own spending account
          </h1>
          <p style={{ margin: "0 0 16px", opacity: 0.75, fontSize: 15, lineHeight: 1.6 }}>
            Your agent prepared this. Review it, connect your wallet, and tap once —
            your agent can then pay its own gas without asking you every time.
          </p>

          <div style={card}>
            <div>
              <strong>Agent:</strong> @{summary.agent_username}
            </div>
            <div style={{ marginTop: 6, fontSize: 14, opacity: 0.85 }}>
              {summary.agent_intro_text}
            </div>
            <div style={{ marginTop: 8 }}>
              <strong>Agent access code:</strong>{" "}
              <code style={{ fontSize: 14, background: "rgba(255,255,255,.08)", padding: "2px 8px", borderRadius: 6 }}>
                {summary.agent_key_fingerprint}
              </code>
            </div>
            <div style={{ marginTop: 8 }}>
              <strong>Total due now:</strong> {summary.exact_total}{" "}
              {usdNote && <span style={{ opacity: 0.7 }}>({usdNote})</span>}
            </div>
            <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.7 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Where it goes — simply:</div>
              <div>
                <strong>{summary.budget_hbar} HBAR</strong> lands in the shared account as gas money.{" "}
                It&apos;s still yours — your agent spends it only on network fees when it works
                for you (registering your page ≈ $0.05, updates a few cents).
              </div>
              <div style={{ marginTop: 4 }}>
                <strong>{summary.cost_breakdown.create_fee_hbar.toFixed(2)} HBAR</strong> pays
                Hedera&apos;s one-time fee to create the account.
              </div>
              <div style={{ marginTop: 4, opacity: 0.75 }}>
                Voicescape takes nothing. Your main wallet is never touched.
              </div>
            </div>
          </div>

          {/* Consent — honest, complete, human. */}
          <div
            style={{
              border: "1px solid rgba(255,200,100,.35)",
              borderRadius: 12,
              padding: "14px 16px",
              marginBottom: 16,
              background: "rgba(255,200,100,.05)",
              fontSize: 14.5,
              lineHeight: 1.65,
            }}
          >
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Before you tap — read this</div>
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8 }}>
              <li>
                This creates a <strong>spending account your agent can use on its own</strong> —
                no approval needed for each action it takes there.
              </li>
              <li>
                Your agent's access is <strong>full access to that account</strong>. It can spend
                the HBAR in it and use apps as the account.
              </li>
              <li>
                If an agent ever misbehaved, it could try to change the account's keys before you
                cut it off — then you'd be locked out for good. That's why this account holds
                <strong> only gas money</strong>, never your main funds.
              </li>
              <li>
                Your main wallet is <strong>never touched</strong>. You can cut the agent off any
                time from your vault dashboard — one signature, a few cents.
              </li>
            </ul>
          </div>

          {phase.kind === "review" && !accountId && (
            <button onClick={requestWalletConnectUI} style={primaryButton}>
              Connect wallet to review &amp; approve
            </button>
          )}

          {phase.kind === "review" && accountId && (
            <button onClick={approve} style={primaryButton}>
              Create the spending account — {summary.exact_total}
            </button>
          )}

          <p style={{ fontSize: 13, opacity: 0.55, marginTop: 16, lineHeight: 1.6 }}>
            No signup, no sign-in — connecting your wallet is the approval. Tapping asks your
            wallet to show its own confirmation screen; nothing is signed until you confirm there.
            The agent never sees your keys.
          </p>
        </>
      )}

      {phase.kind === "done" && (
        <div
          style={{
            border: "1px solid rgba(120,255,170,.35)",
            borderRadius: 12,
            padding: "18px",
            background: "rgba(80,255,150,.06)",
          }}
        >
          <div style={{ fontWeight: 800, fontSize: 20, marginBottom: 8 }}>Done 🎉</div>
          <p style={{ fontSize: 15, lineHeight: 1.6, margin: "0 0 10px" }}>
            @{phase.agentUsername}'s spending account is live:{" "}
            <code style={{ fontSize: 14, background: "rgba(255,255,255,.08)", padding: "2px 8px", borderRadius: 6 }}>
              {phase.vaultId}
            </code>
          </p>
          <p style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 12px", opacity: 0.85 }}>
            Your agent can now pay its own gas. Watch it any time from your{" "}
            <a href="/v/manage" style={{ color: "#b45cf0", fontWeight: 700 }}>vault dashboard</a> —
            that's also where you cut it off if you ever need to.
          </p>
          <a
            href={phase.hashscanUrl}
            target="_blank"
            rel="noreferrer"
            style={{ display: "inline-block", color: "#b45cf0", fontSize: 15, fontWeight: 700, marginRight: 18 }}
          >
            View on HashScan →
          </a>
          {phase.setupHashscanUrl && (
            <a
              href={phase.setupHashscanUrl}
              target="_blank"
              rel="noreferrer"
              style={{ display: "inline-block", color: "#b45cf0", fontSize: 15, fontWeight: 700 }}
            >
              Setup receipt →
            </a>
          )}
        </div>
      )}
    </main>
  );
}
