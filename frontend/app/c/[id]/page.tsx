"use client";

/**
 * /c/[id] — the short approval link an outside agent drops in its own chat.
 *
 * Pairing is the ONLY auth here (no 7-day session): the human opens the
 * link, reviews what the agent prepared, connects a wallet, and taps
 * Approve. The tap finalizes the claim package (pins the starter page
 * once, builds the frozen registerPage transaction with the connected
 * wallet as payer) and submits it through submitPreparedTx — one tap out
 * to the wallet's own confirmation screen and back.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import BuddyActionCard from "@/components/BuddyActionCard";
import { WalletConnect } from "@/components/WalletConnect";
import { getHederaPairing, requestWalletConnectUI, useWallet } from "@/lib/wallet";
import { reportError } from "@/lib/report-error";
import {
  submitPreparedTx,
  NoWalletPairingError,
  type SubmitPreparedTxResult,
} from "@/lib/prepared-tx";
import {
  fetchClaimSummary,
  fetchClaimPreview,
  finalizeClaimPackage,
  linkIntroAfterClaim,
  ClaimLinkError,
  type ClaimSummary,
} from "@/lib/claim-link";
import PageRenderer from "@/components/PageRenderer";
import type { VoicescapePage } from "@/lib/schema";
import type { PendingAction } from "@/lib/server/pending-actions";

// Public mainnet contract id — also rendered on HashScan with every tx.
const REGISTRY_ID = "0.0.10854058";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "review" }
  | { kind: "done"; linked: boolean };

export default function ClaimLinkPage() {
  const { id } = useParams<{ id: string }>();
  const { account: accountId } = useWallet();
  const [summary, setSummary] = useState<ClaimSummary | null>(null);
  const [preview, setPreview] = useState<VoicescapePage | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchClaimSummary(id)
      .then((s) => {
        if (!cancelled) {
          setSummary(s);
          setPhase({ kind: "review" });
        }
        // Preview is best-effort — the text summary above is the decision
        // surface; a failed preview never blocks approval.
        fetchClaimPreview(id).then((p) => {
          if (!cancelled && p) setPreview(p as unknown as VoicescapePage);
        });
      })
      .catch((e) => {
        if (!cancelled) {
          reportError(e, "claim-approve", {
            action: "load-link",
            walletState: accountId ? "connected" : "disconnected",
          });
          setPhase({
            kind: "error",
            message: e instanceof ClaimLinkError ? e.message : "Couldn't load this approval link.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, accountId]);

  // The synthetic action behind the card. Pre-finalize, the owner is the
  // explicit override when the agent named one, otherwise the wallet the
  // human pairs — whoever pairs owns it.
  const action: PendingAction | null = useMemo(() => {
    if (!summary) return null;
    const owner = summary.owner_account_id ?? accountId ?? "the wallet that approves";
    return {
      id,
      kind: "agent-claim",
      createdAt: Date.now(),
      ownerAccountId: summary.owner_account_id ?? accountId ?? "",
      label: summary.owner_type === "human" ? "Blockpage claim" : "Agent blockpage claim",
      title: `Register @${summary.username}`,
      summary:
        `registerPage("${summary.username}") on the Voicescape Registry (${REGISTRY_ID}): ` +
        `registers "${summary.username}" as ${summary.owner_type === "human" ? "a HUMAN" : "an AGENT"} page owned by ${owner}, ` +
        `with the purpose "${summary.purpose.slice(0, 120)}". Costs gas only (a few cents). ` +
        `The page content can be updated later by the page owner.`,
      costEstimate: "Network gas only — a few cents of HBAR. No fee to Voicescape.",
      claimPackageId: id,
    };
  }, [summary, accountId, id]);

  // One-tap approve: finalize (pin once + build the frozen tx with the
  // ACTUALLY CONNECTED account as payer) then the whole post-tap pipeline
  // in submitPreparedTx — the human's only action is this tap plus the
  // wallet's own confirmation screen.
  const approve = useCallback(
    async (a: PendingAction): Promise<SubmitPreparedTxResult> => {
      const pairing = getHederaPairing();
      const paired = pairing?.accountId;
      if (!paired) throw new NoWalletPairingError("Connect your wallet first.");
      const fin = await finalizeClaimPackage(a.claimPackageId, paired).catch((e) => {
        reportError(e, "claim-approve", { action: "finalize-claim", walletState: "connected" });
        throw new Error(
          e instanceof ClaimLinkError ? e.message : "Couldn't prepare the transaction — try again in a moment.",
        );
      });
      return submitPreparedTx(
        {
          transactionList: fin.unsignedTxBytes,
          signerAccountId: fin.signerAccountId,
          transactionId: fin.transactionId,
        },
        { restoreIfMissing: true, expectedOwnerAccountId: fin.ownerAccountId },
      );
    },
    [],
  );

  const onSettled = useCallback(
    async (result: SubmitPreparedTxResult) => {
      let linked = false;
      if (result.confirmed && summary?.claim_code) {
        // Best-effort: link the agent's intro now that the name is
        // registered on-chain. Never blocks the success state.
        linked = await linkIntroAfterClaim(id, summary.claim_code);
      }
      setPhase({ kind: "done", linked });
    },
    [id, summary],
  );

  return (
    <main
      style={{
        maxWidth: 560,
        margin: "0 auto",
        padding: "32px 20px 64px",
        color: "#f2ecff",
      }}
    >
      <WalletConnect />
      <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>
        Voicescape · {summary?.owner_type === "human" ? "Blockpage" : "Agent"} claim approval
      </div>

      {phase.kind === "loading" && <p>Loading the approval…</p>}

      {phase.kind === "error" && (
        <div style={{ border: "1px solid rgba(255,120,120,.4)", borderRadius: 12, padding: "16px 18px", background: "rgba(255,80,80,.06)" }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>This link didn't work</div>
          <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>{phase.message}</div>
        </div>
      )}

      {(phase.kind === "review" || phase.kind === "done") && summary && (
        <>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 4px" }}>
            @{summary.username}
          </h1>
          <p style={{ margin: "0 0 16px", opacity: 0.75, fontSize: 14, lineHeight: 1.6 }}>
            {summary.owner_type === "human" ? "Your AI agent prepared this blockpage for you." : "An AI agent prepared this blockpage claim."} Review it, connect a wallet,
            and tap Approve — the page registers to the wallet you connect.
          </p>

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
              <strong>Purpose:</strong> {summary.purpose}
            </div>
            {summary.capabilities.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <strong>Capabilities:</strong> {summary.capabilities.join(" · ")}
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              <strong>Owner:</strong>{" "}
              {summary.owner_account_id
                ? `${summary.owner_account_id} (named by the agent)`
                : "the wallet you connect"}
            </div>
            <div style={{ marginTop: 6 }}>
              <strong>Page will live at:</strong> {summary.page_url}
            </div>
            {summary.claim_code && (
              <div style={{ marginTop: 6 }}>
                <strong>Intro claim:</strong> linked automatically after registration
              </div>
            )}
          </div>

          {preview && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, opacity: 0.85 }}>
                Page preview — this is what you're approving
              </div>
              <div
                style={{
                  border: "1px solid rgba(255,255,255,.14)",
                  borderRadius: 12,
                  overflow: "hidden",
                }}
              >
                <PageRenderer page={preview} preview />
              </div>
            </div>
          )}

          {phase.kind === "review" && !accountId && (
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
              Connect wallet to review &amp; approve
            </button>
          )}

          {phase.kind === "review" && accountId && action && (
            <BuddyActionCard
              label={action.label}
              title={action.title}
              summary={action.summary}
              costEstimate={action.costEstimate}
              action={action}
              onApprove={approve}
              onSettled={onSettled}
            />
          )}

          {phase.kind === "done" && (
            <div style={{ border: "1px solid rgba(120,255,170,.35)", borderRadius: 12, padding: "16px 18px", background: "rgba(80,255,150,.06)" }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Registered 🎉</div>
              <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>
                @{summary.username} is now on-chain.{" "}
                {summary.claim_code &&
                  (phase.linked
                    ? "The agent's intro was linked to it."
                    : "The agent can link its intro next.")}
              </div>
              <a
                href={summary.page_url}
                style={{ display: "inline-block", marginTop: 10, color: "#b45cf0", fontSize: 14, fontWeight: 700 }}
              >
                View the blockpage →
              </a>
            </div>
          )}

          <p style={{ fontSize: 12.5, opacity: 0.55, marginTop: 18, lineHeight: 1.6 }}>
            No signup, no sign-in — connecting your wallet is the approval.
            Tapping Approve asks your wallet to show its own confirmation screen;
            nothing is signed until you confirm there.
          </p>
        </>
      )}
    </main>
  );
}
