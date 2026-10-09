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

/**
 * Update flow (agent-page-update) — the original /p/<id> flow, unchanged.
 * The wrapper below routes purchase/hire-review approvals to their own
 * flows; anything else lands here.
 */
function UpdateApprovalFlow() {
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

/* ------------------------------------------------------------------ */
/* Purchase + review approval flows (request_purchase_approval /       */
/* request_review_approval). Same Review → Approve → Connect → Done    */
/* shape as the update flow: the tap records intent, the wallet        */
/* connects after, and the action fires once.                          */
/* ------------------------------------------------------------------ */

interface ApprovalSummary {
  approval_id: string;
  kind: "purchase" | "hire-review";
  title: string;
  summary: string;
  cost_estimate: string;
  owner_account_id: string;
  expires_at: string;
  purchase?: {
    listing_id: string;
    title: string;
    seller: string;
    seller_evm: string;
    contract_id: string;
    price_usd_cents: number;
    value_tinybar: string;
    value_hbar: string;
    split: string;
  };
  review?: {
    reviewer_username: string;
    target_username: string;
    rating: number;
    text: string;
    proof_tx_id: string;
    proof_kind: string;
    proof_url: string;
  };
}

async function fetchApproval(id: string): Promise<ApprovalSummary> {
  const res = await fetch(`/api/approvals/${encodeURIComponent(id)}`, { cache: "no-store" });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new Error(
      typeof body?.error === "string" && body.error
        ? body.error
        : "This approval link is invalid or expired — ask your agent for a fresh request.",
    );
  }
  return body as unknown as ApprovalSummary;
}

type ApprovalPhase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "review" }
  | { kind: "working" }
  | { kind: "done"; txId?: string };

const cardStyle: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,.14)",
  borderRadius: 12,
  padding: "14px 16px",
  marginBottom: 12,
  fontSize: 14,
  lineHeight: 1.65,
};

const primaryBtn: React.CSSProperties = {
  width: "100%",
  padding: "14px",
  borderRadius: 12,
  border: "none",
  background: "linear-gradient(135deg,#7b3ff2,#b45cf0)",
  color: "white",
  fontSize: 16,
  fontWeight: 800,
  cursor: "pointer",
};

function ApprovalShell({
  kicker,
  heading,
  intro,
  children,
}: {
  kicker: string;
  heading: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "32px 20px 64px", color: "#f2ecff" }}>
      <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>
        {kicker}
      </div>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 4px" }}>{heading}</h1>
      <p style={{ margin: "0 0 16px", opacity: 0.75, fontSize: 14, lineHeight: 1.6 }}>{intro}</p>
      {children}
      <p style={{ fontSize: 12.5, opacity: 0.55, marginTop: 18, lineHeight: 1.6 }}>
        No signup, no sign-in. Tapping Approve is your go-ahead — nothing happens until you connect
        the wallet your agent serves and confirm in the wallet's own screen.
      </p>
    </main>
  );
}

/** Purchase approval: the human's wallet signs buyListing itself. */
function PurchaseApprovalFlow({ id }: { id: string }) {
  const { account: accountId } = useWallet();
  const [summary, setSummary] = useState<ApprovalSummary | null>(null);
  const [phase, setPhase] = useState<ApprovalPhase>({ kind: "loading" });
  const [intentApproved, setIntentApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchApproval(id)
      .then((s) => {
        if (!live) return;
        setSummary(s);
        setPhase({ kind: "review" });
      })
      .catch((e) => {
        if (!live) return;
        setPhase({ kind: "error", message: e instanceof Error ? e.message : "Couldn't load this approval." });
      });
    return () => {
      live = false;
    };
  }, [id]);

  const buy = useCallback(async () => {
    if (!summary?.purchase) return;
    setError(null);
    const pairing = getHederaPairing();
    const paired = pairing?.accountId;
    if (!paired) {
      setError("Connect your wallet first.");
      return;
    }
    if (paired !== summary.owner_account_id) {
      setError("This approval belongs to a different wallet — connect the wallet your agent serves.");
      return;
    }
    setPhase({ kind: "working" });
    try {
      const { createHederaTxSender } = await import("@/lib/tx");
      const { getActiveChain } = await import("@/lib/chains");
      const { buyListing } = await import("@/lib/contracts");
      const sender = createHederaTxSender(pairing.hc, paired, getActiveChain());
      // buyListing takes value in wei (18 decimals); the approval carries tinybar (8 decimals).
      const valueWei = BigInt(summary.purchase.value_tinybar) * 10_000_000_000n;
      const txHash = await buyListing(summary.purchase.seller_evm, summary.purchase.listing_id, valueWei, sender);
      // Tell the server the wallet signed — it clears the pending approval.
      const res = await fetch(`/api/approvals/${encodeURIComponent(id)}/complete-purchase`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: paired, tx_id: txHash }),
      });
      const body = (await res.json().catch(() => null)) as { hashscan_url?: string } | null;
      if (!res.ok) {
        // The purchase itself is on-chain (the wallet signed it) — the
        // approval just didn't clear. Hand the human the proof, not an error.
        setPhase({ kind: "done", txId: txHash });
        return;
      }
      setPhase({ kind: "done", txId: txHash });
      void body;
    } catch (e) {
      reportError(e, "purchase-approve", { action: "buy-listing", walletState: "connected" });
      setError(e instanceof Error ? e.message : "Couldn't complete the purchase — try again.");
      setPhase({ kind: "review" });
    }
  }, [id, summary]);

  const p = summary?.purchase;
  const expiresSoon = summary && Date.now() > new Date(summary.expires_at).getTime() - 2 * 3_600_000;

  return (
    <ApprovalShell
      kicker="Voicescape · Purchase approval"
      heading={p ? `Buy "${p.title}"` : "Purchase approval"}
      intro="Your AI agent found this listing for you. Review it, tap Approve, then connect your wallet to buy — one signature and the Tips contract splits your payment 98% to the seller and 2% to the platform, atomically."
    >
      {intentApproved && <WalletConnect />}
      {phase.kind === "loading" && <p>Loading the approval…</p>}
      {phase.kind === "error" && (
        <div style={{ ...cardStyle, borderColor: "rgba(255,120,120,.4)", background: "rgba(255,80,80,.06)" }}>
          <div style={{ fontSize: 14, lineHeight: 1.6 }}>{phase.message}</div>
        </div>
      )}
      {(phase.kind === "review" || phase.kind === "working" || phase.kind === "done") && p && summary && (
        <>
          <div style={cardStyle}>
            <div><strong>Item:</strong> {p.title}</div>
            <div style={{ marginTop: 6 }}><strong>Seller:</strong> {p.seller}</div>
            <div style={{ marginTop: 6 }}>
              <strong>Price:</strong> {p.value_hbar} HBAR
              <span style={{ opacity: 0.65 }}> (${(p.price_usd_cents / 100).toFixed(2)})</span>
            </div>
            <div style={{ marginTop: 6 }}><strong>Split:</strong> {p.split}</div>
            <div style={{ marginTop: 6 }}><strong>Cost:</strong> {summary.cost_estimate}</div>
            <div style={{ marginTop: 6 }}>
              <strong>Buyer wallet:</strong> {summary.owner_account_id} — connect this wallet to approve
            </div>
            {expiresSoon && (
              <div style={{ marginTop: 6, color: "#ffb86b" }}>
                <strong>Expiring soon</strong> — untapped approvals expire 24h after the agent sends them.
              </div>
            )}
          </div>

          {phase.kind === "review" && !intentApproved && (
            <button onClick={() => setIntentApproved(true)} style={primaryBtn}>
              Approve — I'll buy it
            </button>
          )}
          {phase.kind === "review" && intentApproved && !accountId && (
            <>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, opacity: 0.8, margin: "0 0 10px" }}>
                Approved ✓ — now connect the wallet shown above. The purchase signature fires when you tap Buy.
              </p>
              <button onClick={requestWalletConnectUI} style={primaryBtn}>
                Connect wallet
              </button>
            </>
          )}
          {phase.kind === "review" && intentApproved && accountId && (
            <button onClick={buy} style={primaryBtn}>
              Buy now — {p.value_hbar} HBAR
            </button>
          )}
          {phase.kind === "working" && (
            <div style={{ ...primaryBtn, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.14)", textAlign: "center" }}>
              Check your wallet — confirm the purchase…
            </div>
          )}
          {error && (
            <div style={{ ...cardStyle, borderColor: "rgba(255,120,120,.4)", background: "rgba(255,80,80,.06)", marginTop: 10 }}>
              <div style={{ fontSize: 14, lineHeight: 1.6 }}>{error}</div>
            </div>
          )}
          {phase.kind === "done" && (
            <div style={{ border: "1px solid rgba(120,255,170,.35)", borderRadius: 12, padding: "16px 18px", background: "rgba(80,255,150,.06)" }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Purchased 🎉</div>
              <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>
                Your wallet signed the purchase — the 98/2 split was enforced on-chain.
              </div>
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
                  <div style={{ opacity: 0.55, fontSize: 12, marginTop: 2 }}>Verify it yourself on HashScan</div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </ApprovalShell>
  );
}

/** Review approval: the human's tap posts the review server-side. */
function ReviewApprovalFlow({ id }: { id: string }) {
  const { account: accountId } = useWallet();
  const [summary, setSummary] = useState<ApprovalSummary | null>(null);
  const [phase, setPhase] = useState<ApprovalPhase>({ kind: "loading" });
  const [intentApproved, setIntentApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchApproval(id)
      .then((s) => {
        if (!live) return;
        setSummary(s);
        setPhase({ kind: "review" });
      })
      .catch((e) => {
        if (!live) return;
        setPhase({ kind: "error", message: e instanceof Error ? e.message : "Couldn't load this approval." });
      });
    return () => {
      live = false;
    };
  }, [id]);

  const post = useCallback(async () => {
    if (!summary) return;
    setError(null);
    const pairing = getHederaPairing();
    const paired = pairing?.accountId;
    if (!paired) {
      setError("Connect your wallet first.");
      return;
    }
    if (paired !== summary.owner_account_id) {
      setError("This approval belongs to a different wallet — connect the wallet your agent serves.");
      return;
    }
    setPhase({ kind: "working" });
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(id)}/approve-review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: paired }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        throw new Error(
          typeof body?.error === "string" && body.error
            ? body.error
            : "Couldn't post the review — try again in a moment.",
        );
      }
      setPhase({ kind: "done" });
    } catch (e) {
      reportError(e, "review-approve", { action: "post-review", walletState: "connected" });
      setError(e instanceof Error ? e.message : "Couldn't post the review — try again.");
      setPhase({ kind: "review" });
    }
  }, [id, summary]);

  const r = summary?.review;
  const expiresSoon = summary && Date.now() > new Date(summary.expires_at).getTime() - 2 * 3_600_000;

  return (
    <ApprovalShell
      kicker="Voicescape · Review approval"
      heading={r ? `Review @${r.target_username}` : "Review approval"}
      intro="Your AI agent drafted this hire review, backed by a settled on-chain payment. Review it and tap Approve to post — nothing posts until you do."
    >
      {intentApproved && <WalletConnect />}
      {phase.kind === "loading" && <p>Loading the approval…</p>}
      {phase.kind === "error" && (
        <div style={{ ...cardStyle, borderColor: "rgba(255,120,120,.4)", background: "rgba(255,80,80,.06)" }}>
          <div style={{ fontSize: 14, lineHeight: 1.6 }}>{phase.message}</div>
        </div>
      )}
      {(phase.kind === "review" || phase.kind === "working" || phase.kind === "done") && r && summary && (
        <>
          <div style={cardStyle}>
            <div>
              <strong>Reviewer:</strong> @{r.reviewer_username} → <strong>for:</strong> @{r.target_username}
            </div>
            <div style={{ marginTop: 6 }}>
              <strong>Rating:</strong> {"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)} ({r.rating}/5)
            </div>
            {r.text && (
              <div style={{ marginTop: 6 }}>
                <strong>Review:</strong> {r.text}
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              <strong>Proof of payment:</strong>{" "}
              <a href={r.proof_url} target="_blank" rel="noopener noreferrer" style={{ color: "#b45cf0", fontWeight: 700, wordBreak: "break-all" }}>
                {r.proof_tx_id} ↗
              </a>
            </div>
            <div style={{ marginTop: 6 }}><strong>Cost:</strong> {summary.cost_estimate}</div>
            {expiresSoon && (
              <div style={{ marginTop: 6, color: "#ffb86b" }}>
                <strong>Expiring soon</strong> — untapped approvals expire 24h after the agent sends them.
              </div>
            )}
          </div>

          {phase.kind === "review" && !intentApproved && (
            <button onClick={() => setIntentApproved(true)} style={primaryBtn}>
              Approve — post the review
            </button>
          )}
          {phase.kind === "review" && intentApproved && !accountId && (
            <>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, opacity: 0.8, margin: "0 0 10px" }}>
                Approved ✓ — now connect the wallet your agent serves to confirm it's you.
              </p>
              <button onClick={requestWalletConnectUI} style={primaryBtn}>
                Connect wallet
              </button>
            </>
          )}
          {phase.kind === "review" && intentApproved && accountId && (
            <button onClick={post} style={primaryBtn}>
              Post review
            </button>
          )}
          {phase.kind === "working" && (
            <div style={{ ...primaryBtn, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.14)", textAlign: "center" }}>
              Posting the review…
            </div>
          )}
          {error && (
            <div style={{ ...cardStyle, borderColor: "rgba(255,120,120,.4)", background: "rgba(255,80,80,.06)", marginTop: 10 }}>
              <div style={{ fontSize: 14, lineHeight: 1.6 }}>{error}</div>
            </div>
          )}
          {phase.kind === "done" && (
            <div style={{ border: "1px solid rgba(120,255,170,.35)", borderRadius: 12, padding: "16px 18px", background: "rgba(80,255,150,.06)" }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Review posted 🎉</div>
              <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>
                The {r.rating}/5 review of @{r.target_username} is live, backed by the on-chain payment.
              </div>
            </div>
          )}
        </>
      )}
    </ApprovalShell>
  );
}

/**
 * /p/[id] — routes to the right approval flow. Purchase and hire-review
 * approvals (request_purchase_approval / request_review_approval) get
 * their own cards; everything else falls through to the original
 * page-update flow, unchanged.
 */
export default function ProposalLinkPage() {
  const { id } = useParams<{ id: string }>();
  const [kind, setKind] = useState<"purchase" | "hire-review" | "other" | null>(null);

  useEffect(() => {
    let live = true;
    fetchApproval(id)
      .then((s) => {
        if (live) setKind(s.kind);
      })
      .catch(() => {
        if (live) setKind("other");
      });
    return () => {
      live = false;
    };
  }, [id]);

  if (kind === null) {
    return (
      <main style={{ maxWidth: 560, margin: "0 auto", padding: "32px 20px 64px", color: "#f2ecff" }}>
        <p>Loading the approval…</p>
      </main>
    );
  }
  if (kind === "purchase") return <PurchaseApprovalFlow id={id} />;
  if (kind === "hire-review") return <ReviewApprovalFlow id={id} />;
  return <UpdateApprovalFlow />;
}
