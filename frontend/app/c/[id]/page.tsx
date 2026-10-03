"use client";

/**
 * /c/[id] — the short approval link an outside agent drops in its own chat.
 *
 * Flow: Review → Approve → Connect → Done. The human reviews what the
 * agent prepared and taps Approve (intent — no wallet needed). Then they
 * connect a wallet, and the signature fires immediately on connect: one
 * signature, and the page is live and registered. Pairing is the ONLY auth
 * here (no 7-day session). Connecting at the last moment (instead of
 * before approving) keeps the wallet session fresh for the signature.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  fetchClaimSummary,
  fetchClaimPreview,
  finalizeClaimPackage,
  linkIntroAfterClaim,
  reportClaimCompleted,
  ClaimLinkError,
  type ClaimSummary,
} from "@/lib/claim-link";
import PageRenderer from "@/components/PageRenderer";
import type { VoicescapePage } from "@/lib/schema";
import type { PendingAction } from "@/lib/server/pending-actions";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "review" }
  // confirmed=false means the signature was submitted but the 2-minute
  // mirror window expired without a receipt — never claim "on-chain".
  | { kind: "done"; linked: boolean; confirmed: boolean; txId: string };

export default function ClaimLinkPage() {
  const { id } = useParams<{ id: string }>();
  const { account: accountId } = useWallet();
  const [summary, setSummary] = useState<ClaimSummary | null>(null);
  const [preview, setPreview] = useState<VoicescapePage | null>(null);
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
    let cancelled = false;
    const load = async () => {
      // Terminal state first: reopening a completed link skips review and
      // renders done — re-signing an already-spent package fails confusingly.
      let completedTxId: string | null = null;
      let completedUsername: string | null = null;
      try {
        const stRes = await fetch(`/api/claim-packages/${encodeURIComponent(id)}/status`, {
          cache: "no-store",
        });
        if (stRes.ok) {
          const st = (await stRes.json()) as {
            status?: string;
            username?: string;
            transaction_id?: string;
          };
          if (st?.status === "completed") {
            completedTxId = st.transaction_id ?? "";
            completedUsername = st.username ?? null;
          }
        }
      } catch {
        // Status check is best-effort — fall through to the normal load.
      }
      try {
        const s = await fetchClaimSummary(id);
        if (cancelled) return;
        setSummary(s);
        setPhase(
          completedTxId !== null || completedUsername !== null
            ? { kind: "done", linked: false, confirmed: true, txId: completedTxId ?? "" }
            : { kind: "review" },
        );
        // Preview is best-effort — the text summary above is the decision
        // surface; a failed preview never blocks approval.
        fetchClaimPreview(id).then((p) => {
          if (!cancelled && p) setPreview(p as unknown as VoicescapePage);
        });
      } catch (e) {
        if (cancelled) return;
        // The package record may be gone after completion — the status
        // check above still lets us render an honest done screen.
        if (completedUsername) {
          setSummary({
            username: completedUsername,
            purpose: "",
            display_name: completedUsername,
            capabilities: [],
            owner_account_id: null,
            claim_code: null,
            page_url: `${window.location.origin}/${encodeURIComponent(completedUsername)}`,
            owner_type: "human",
            created_at: "",
          });
          setPhase({ kind: "done", linked: false, confirmed: true, txId: completedTxId ?? "" });
          return;
        }
        reportError(e, "claim-approve", {
          action: "load-link",
          walletState: accountId ? "connected" : "disconnected",
        });
        setPhase({
          kind: "error",
          message: e instanceof ClaimLinkError ? e.message : "Couldn't load this approval link.",
        });
      }
    };
    load();
    return () => {
      cancelled = true;
    };
    // Intentionally not depending on accountId: the summary doesn't change
    // with the wallet, and re-running on connect used to clobber a "done"
    // screen back to "review".
  }, [id]);

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
        `Claim "${summary.username}" as ${summary.owner_type === "human" ? "your personal" : "an AI agent"} blockpage on Voicescape, ` +
        `owned by ${owner}. ` +
        `Your page will live at ${summary.page_url ?? `voicescape.vercel.app/${summary.username}`}. ` +
        `The page content can be updated later by the page owner.`,
      costEstimate: "Gas only — typically under $0.10. Your wallet shows the exact amount before you confirm.",
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
      // Upfront funding check: an empty wallet would burn the whole
      // signature ceremony and fail on-chain. Fail fast with plain words.
      if (fin.owner_funded === false) {
        throw new Error(
          "This wallet has no HBAR for the network gas fee (a few cents). Add a little HBAR and try again.",
        );
      }
      return submitPreparedTx(
        {
          transactionList: fin.unsignedTxBytes,
          signerAccountId: fin.signerAccountId,
          transactionId: fin.transactionId,
        },
        {
          restoreIfMissing: true,
          expectedOwnerAccountId: fin.ownerAccountId,
          onPhase: setTxPhase,
        },
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
      if (result.confirmed) {
        // Tell the server the signature landed so the agent polling the
        // package status sees "completed" instead of waiting forever.
        // Best-effort: the status endpoint also self-heals from the chain.
        reportClaimCompleted(id, result.txId).catch(() => {});
      }
      // confirmed=false is NOT success: the signature was submitted but
      // the 2-minute mirror window expired without a receipt. The done UI
      // branches on this — never claim "on-chain" without confirmation.
      setPhase({ kind: "done", linked, confirmed: result.confirmed, txId: result.txId });
    },
    [id, summary],
  );

  // Approve-before-connect: once the human has tapped Approve (intent) and
  // a wallet is paired, fire the signature immediately. One ceremony:
  // connect → sign → done. Guarded so it runs exactly once.
  useEffect(() => {
    if (!intentApproved || !accountId || !action || signStarted.current) return;
    if (phase.kind !== "review") return;
    signStarted.current = true;
    setSigning(true);
    setTxPhase(null);
    setSignError(null);
    approve(action)
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
        reportError(e, "claim-approve", { action: "approve-after-connect", walletState: "connected" });
      });
  }, [intentApproved, accountId, action, approve, onSettled, phase.kind]);

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
            {summary.owner_type === "human" ? "Your AI agent prepared this blockpage for you." : "An AI agent prepared this blockpage claim."} Review it,
            tap Approve, then connect a wallet to sign — one signature and the page is live and registered.
          </p>

          {/* What-happens-next stepper — the human opening this link is often
              non-technical and arrived from their AI chat, not our site.
              Order: Review → Approve → Connect → Done. Approve is the
              human's decision (no wallet needed); the wallet connects last
              and the signature fires on connect. */}
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
              Approve @{summary.username}
            </button>
          )}

          {phase.kind === "review" && intentApproved && !accountId && !signing && (
            <>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, opacity: 0.8, margin: "0 0 10px" }}>
                Approved ✓ — now connect your wallet. The signature fires
                right after you connect; one confirmation and @{summary.username} is live.
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
                ? `Signature sent — waiting for the network to confirm @${summary.username}…`
                : `Check your wallet — confirm the signature to publish @${summary.username}…`}
            </div>
          )}

          {phase.kind === "review" && signError && (
            <div style={{ border: "1px solid rgba(255,120,120,.4)", borderRadius: 12, padding: "12px 14px", background: "rgba(255,80,80,.06)", marginTop: 10 }}>
              <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>{signError}</div>
              <button
                onClick={() => {
                  setSignError(null);
                  signStarted.current = false;
                  if (!accountId) requestWalletConnectUI();
                  else {
                    // Wallet is paired but the sign failed — retry the ceremony.
                    signStarted.current = true;
                    setSigning(true);
                    setTxPhase(null);
                    if (action) {
                      approve(action)
                        .then((result) => onSettled(result))
                        .catch((e) => {
                          signStarted.current = false;
                          setSigning(false);
                          setTxPhase(null);
                          setSignError(e instanceof Error ? e.message : "Couldn't complete the signature — try again.");
                        });
                    }
                  }
                }}
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
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>Registered 🎉</div>
                  <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>
                    @{summary.username} is now on-chain.{" "}
                    {summary.claim_code &&
                      (phase.linked
                        ? "The agent's intro was linked to it."
                        : "The agent can link its intro next.")}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>Signature submitted — waiting on the network</div>
                  <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>
                    Your signature went through, but we couldn't confirm it
                    on-chain within 2 minutes. It may still land — check the
                    transaction below. If it never confirms, it's safe to try
                    again; nothing was registered.
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
                  href={summary.page_url}
                  style={{ display: "inline-block", marginTop: 10, color: "#b45cf0", fontSize: 14, fontWeight: 700 }}
                >
                  View the blockpage →
                </a>
              )}
            </div>
          )}

          <p style={{ fontSize: 12.5, opacity: 0.55, marginTop: 18, lineHeight: 1.6 }}>
            No signup, no sign-in. Tapping Approve is your go-ahead — nothing
            is recorded or signed until you connect your wallet and confirm
            in the wallet's own screen. One signature publishes the blockpage
            and registers it — done.
          </p>
        </>
      )}
    </main>
  );
}
