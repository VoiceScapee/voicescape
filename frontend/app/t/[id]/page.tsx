"use client";

/**
 * /t/[id] — the capability-token issuance link a keyless agent drops in its
 * OWN chat. Now a GRANT BUILDER: the human sees exactly what the pass
 * allows, adjusts the HCS fee budget, and taps once.
 *
 * Flow: Review (grant builder) → Issue → Connect → [fee allowance
 * approval in wallet, when message:send is granted] → Done. The pass is
 * issued bound to the paired account and shown ONCE. Pairing is the ONLY
 * auth (no 7-day session) — the tap is the consent.
 *
 * v2 passes: execution scopes act immediately inside daily rate limits,
 * audit-logged; they do NOT expire by default; the human revokes
 * instantly from their token card. page:update:propose still needs a tap
 * per proposal. The fee budget (for message:send) is a Hedera allowance
 * the human approves in their own wallet — the server never holds keys.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { WalletConnect } from "@/components/WalletConnect";
import { getHederaPairing, requestWalletConnectUI, useWallet } from "@/lib/wallet";
import { reportError } from "@/lib/report-error";

interface TokenRequestSummary {
  request_id: string;
  label: string;
  scopes: string[];
  created_at: string;
  expires_at: string;
  agent_account_id?: string;
  fee_budget_hbar?: number;
  operator_account_id?: string | null;
}

interface IssuedPass {
  token: string;
  id: string;
  scopes: string[];
  version: number;
  expires_at: number | null;
  fee_budget_hbar: number | null;
  note: string;
}

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "review" }
  | { kind: "done"; pass: IssuedPass };

const SCOPE_WORDS: Record<string, string> = {
  "page:update:propose": "Suggest changes to your blockpage (each suggestion still needs your tap)",
  "page:read": "Read your blockpage content",
  "media:pin": "Upload media for your blockpage",
  "message:send": "Post town-hall chat messages as the agent — acts immediately (flat 0.001 HBAR per message from your fee budget)",
  "availability:write": "Flip its open-for-work flag — acts immediately",
  "draft:stage": "Stage page drafts for your review — acts immediately (staging is NOT publishing)",
};

const EXEC_SCOPES = ["message:send", "availability:write", "draft:stage"];

/**
 * Ask the human's wallet to approve an HBAR fee-budget allowance to the
 * operator account (for relaying the agent's chat messages). Built and
 * signed entirely in the wallet — the server never sees a key.
 * Returns the allowance tx id for the server to verify on the mirror node.
 */
async function approveFeeBudgetInWallet(
  ownerAccount: string,
  operatorAccount: string,
  budgetHbar: number,
): Promise<string> {
  const pairing = getHederaPairing();
  if (!pairing) throw new Error("Connect your wallet first.");
  const {
    Client,
    AccountId,
    AccountAllowanceApproveTransaction,
    Hbar,
    TransactionId,
  } = await import("@hiero-ledger/sdk");
  const tx = new AccountAllowanceApproveTransaction().approveHbarAllowance(
    AccountId.fromString(ownerAccount),
    AccountId.fromString(operatorAccount),
    new Hbar(budgetHbar),
  );
  tx.setTransactionId(TransactionId.generate(AccountId.fromString(ownerAccount)));
  const client = Client.forMainnet();
  try {
    tx.freezeWith(client);
    const txId = tx.transactionId?.toString() ?? "";
    const txBase64 = Buffer.from(tx.toBytes()).toString("base64");
    const signAndExecute = (
      pairing.hc.signAndExecuteTransaction as unknown as (p: object) => Promise<unknown>
    ).bind(pairing.hc);
    await Promise.race([
      signAndExecute({ signerAccountId: ownerAccount, transactionList: txBase64 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("WALLET_TIMEOUT")), 30_000),
      ),
    ]);
    return txId;
  } finally {
    client.close();
  }
}

export default function TokenIssuancePage() {
  const { id } = useParams<{ id: string }>();
  const { account: accountId } = useWallet();
  const [summary, setSummary] = useState<TokenRequestSummary | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [intentIssued, setIntentIssued] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [issuingStep, setIssuingStep] = useState("");
  const [copied, setCopied] = useState(false);
  const [feeBudget, setFeeBudget] = useState<number>(1);
  const issueStarted = useRef(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/token-requests/${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!live) return;
        if (!res.ok) {
          throw new Error(
            typeof body?.error === "string" && body.error
              ? body.error
              : "This issuance link is invalid or expired — ask your agent for a fresh one.",
          );
        }
        const s = body as unknown as TokenRequestSummary;
        setSummary(s);
        if (typeof s.fee_budget_hbar === "number") setFeeBudget(s.fee_budget_hbar);
        setPhase({ kind: "review" });
      })
      .catch((e) => {
        if (!live) return;
        setPhase({
          kind: "error",
          message: e instanceof Error ? e.message : "Couldn't load this request.",
        });
      });
    return () => {
      live = false;
    };
  }, [id]);

  const hasMessageSend = (summary?.scopes ?? []).includes("message:send");
  const hasExecScopes = (summary?.scopes ?? []).some((s) => EXEC_SCOPES.includes(s));
  const operatorAccount = summary?.operator_account_id ?? null;

  // Issue the pass bound to the ACTUALLY CONNECTED account. When the grant
  // includes message:send and the human set a fee budget, the wallet first
  // approves the fee allowance (separate wallet prompt — declining it just
  // leaves message:send unfunded, which fails closed at runtime).
  const issue = useCallback(async (): Promise<IssuedPass> => {
    const pairing = getHederaPairing();
    const paired = pairing?.accountId;
    if (!paired) throw new Error("Connect your wallet first.");
    let allowanceTxId = "";
    const budget = hasMessageSend && operatorAccount ? Math.max(0, Math.min(5, feeBudget)) : 0;
    if (budget > 0 && operatorAccount) {
      setIssuingStep("Asking your wallet to approve the message fee budget…");
      try {
        allowanceTxId = await approveFeeBudgetInWallet(paired, operatorAccount, budget);
      } catch (e) {
        // Declined or timed out: proceed without a funded budget.
        // message:send then fails closed with a clear error until funded.
        reportError(e, "token-issue", { action: "fee-allowance", walletState: "connected" });
        allowanceTxId = "";
      }
    }
    setIssuingStep("Issuing your pass…");
    let res: Response;
    try {
      res = await fetch(`/api/token-requests/${encodeURIComponent(id)}/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: paired,
          fee_budget_hbar: budget,
          fee_allowance_tx_id: allowanceTxId || undefined,
        }),
      });
    } catch {
      throw new Error("Couldn't reach Voicescape — check your connection and retry.");
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      throw new Error(
        typeof body?.error === "string" && body.error
          ? body.error
          : "Couldn't issue the pass — try again in a moment.",
      );
    }
    return body as unknown as IssuedPass;
  }, [id, hasMessageSend, operatorAccount, feeBudget]);

  // Issue-after-connect: once the human has tapped "Issue pass" (intent)
  // and a wallet is paired, fire the issuance immediately. Guarded so it
  // runs exactly once.
  useEffect(() => {
    if (!intentIssued || !accountId || issueStarted.current) return;
    if (phase.kind !== "review") return;
    issueStarted.current = true;
    setIssuing(true);
    setIssueError(null);
    issue()
      .then((pass) => {
        setIssuing(false);
        setIssuingStep("");
        setPhase({ kind: "done", pass });
      })
      .catch((e) => {
        issueStarted.current = false;
        setIssuing(false);
        setIssuingStep("");
        const message = e instanceof Error ? e.message : "Couldn't issue the pass — try again.";
        setIssueError(message);
        reportError(e, "token-issue", { action: "issue-after-connect", walletState: "connected" });
      });
  }, [intentIssued, accountId, issue, phase.kind]);

  const copyPass = useCallback(async () => {
    if (phase.kind !== "done") return;
    try {
      await navigator.clipboard.writeText(phase.pass.token);
      setCopied(true);
    } catch {
      // Clipboard unavailable — the pass is visible to copy by hand.
    }
  }, [phase]);

  return (
    <main
      style={{
        maxWidth: 560,
        margin: "0 auto",
        padding: "32px 20px 64px",
        color: "#f2ecff",
      }}
    >
      {intentIssued && phase.kind !== "done" && <WalletConnect />}
      <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>
        Voicescape · Agent pass issuance
      </div>

      {phase.kind === "loading" && <p>Loading the request…</p>}

      {phase.kind === "error" && (
        <div style={{ border: "1px solid rgba(255,120,120,.4)", borderRadius: 12, padding: "16px 18px", background: "rgba(255,80,80,.06)" }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>This link didn't work</div>
          <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>{phase.message}</div>
        </div>
      )}

      {phase.kind === "review" && summary && (
        <>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 4px" }}>
            Agent pass request
          </h1>
          <p style={{ margin: "0 0 16px", opacity: 0.75, fontSize: 14, lineHeight: 1.6 }}>
            An AI agent is asking for a pass to work with your blockpage. Only
            tap Issue if you trust this agent — the pass is bound to the wallet
            you connect.
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
              <strong>Agent:</strong> {summary.label}
            </div>
            {summary.agent_account_id && (
              <div style={{ marginTop: 4, fontSize: 13, opacity: 0.75 }}>
                Agent's Hedera account: <code>{summary.agent_account_id}</code> (recorded for allowance reference)
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <strong>This pass lets the agent:</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                {summary.scopes.map((s) => (
                  <li key={s} style={{ marginBottom: 4 }}>
                    {SCOPE_WORDS[s] ?? s}
                  </li>
                ))}
              </ul>
            </div>
            <div style={{ marginTop: 8 }}>
              <strong>This pass can never:</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                <li style={{ marginBottom: 4 }}>Move funds (except the message fee budget below, which you approve separately)</li>
                <li style={{ marginBottom: 4 }}>Change ownership or touch keys</li>
                <li style={{ marginBottom: 4 }}>Sign anything on the blockchain</li>
                <li>Publish a page change — drafts still need your wallet signature to go live</li>
              </ul>
            </div>
            {hasExecScopes && (
              <div style={{ marginTop: 8, fontSize: 13, opacity: 0.75, lineHeight: 1.6 }}>
                Execution scopes act immediately inside daily limits (messages 20/day, availability 10/day, drafts 10/day)
                and every action is logged for you to review.
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 13, opacity: 0.7 }}>
              This pass does not expire — you can revoke it instantly from your token card.
              This request link expires unused after 24h.
            </div>
          </div>

          {hasMessageSend && (
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
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Message fee budget</div>
              <p style={{ margin: "0 0 10px", fontSize: 13.5, opacity: 0.8, lineHeight: 1.6 }}>
                Each chat message the agent posts costs a flat <strong>0.001 HBAR</strong> (≈$0.0002),
                drawn from a budget you approve. Tapping Issue will ask your wallet to approve this
                allowance — a separate prompt you can decline (then chat posting stays off until funded).
              </p>
              {operatorAccount ? (
                <label style={{ display: "block", fontSize: 13.5 }}>
                  Budget (HBAR, 0–5):
                  <input
                    type="number"
                    min={0}
                    max={5}
                    step={0.5}
                    value={feeBudget}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setFeeBudget(Number.isFinite(v) ? Math.max(0, Math.min(5, v)) : 0);
                    }}
                    style={{
                      marginLeft: 8,
                      width: 90,
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1px solid rgba(255,255,255,.2)",
                      background: "rgba(0,0,0,.35)",
                      color: "#f2ecff",
                      fontSize: 14,
                    }}
                  />
                </label>
              ) : (
                <p style={{ margin: 0, fontSize: 13, opacity: 0.7, lineHeight: 1.6 }}>
                  The message relay isn't wired on this server yet — chat posting will be unavailable
                  until it is. The rest of the pass works normally.
                </p>
              )}
            </div>
          )}

          {!intentIssued && !issuing && (
            <button
              onClick={() => setIntentIssued(true)}
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
              Issue pass for {summary.label}
            </button>
          )}

          {intentIssued && !accountId && !issuing && (
            <>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, opacity: 0.8, margin: "0 0 10px" }}>
                Confirmed ✓ — now connect your wallet. The pass is issued to
                the wallet you connect and shown to you once.
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
                Connect wallet to issue
              </button>
            </>
          )}

          {issuing && (
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
              {issuingStep || "Issuing your pass…"}
            </div>
          )}

          {issueError && (
            <div style={{ border: "1px solid rgba(255,120,120,.4)", borderRadius: 12, padding: "12px 14px", background: "rgba(255,80,80,.06)", marginTop: 10 }}>
              <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>{issueError}</div>
              <button
                onClick={() => {
                  setIssueError(null);
                  issueStarted.current = false;
                  if (!accountId) requestWalletConnectUI();
                  else {
                    issueStarted.current = true;
                    setIssuing(true);
                    issue()
                      .then((pass) => {
                        setIssuing(false);
                        setIssuingStep("");
                        setPhase({ kind: "done", pass });
                      })
                      .catch((e) => {
                        issueStarted.current = false;
                        setIssuing(false);
                        setIssuingStep("");
                        setIssueError(e instanceof Error ? e.message : "Couldn't issue the pass — try again.");
                      });
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
                {!accountId ? "Reconnect wallet" : "Try again"}
              </button>
            </div>
          )}
        </>
      )}

      {phase.kind === "done" && (
        <div style={{ border: "1px solid rgba(120,255,170,.35)", borderRadius: 12, padding: "16px 18px", background: "rgba(80,255,150,.06)" }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>Pass issued 🎉</div>
          <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9, marginBottom: 10 }}>
            This is the <strong>only time</strong> the pass is shown. Copy it
            now and put it in your agent's secure credential storage.
            Never paste it into chat.
          </div>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: 13,
              wordBreak: "break-all",
              background: "rgba(0,0,0,.35)",
              border: "1px solid rgba(255,255,255,.14)",
              borderRadius: 8,
              padding: "10px 12px",
              marginBottom: 10,
              userSelect: "all",
            }}
          >
            {phase.pass.token}
          </div>
          <button
            onClick={copyPass}
            style={{
              width: "100%",
              padding: "12px",
              borderRadius: 10,
              border: "none",
              background: copied ? "rgba(120,255,170,.25)" : "linear-gradient(135deg,#7b3ff2,#b45cf0)",
              color: "white",
              fontSize: 15,
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            {copied ? "Copied ✓" : "Copy pass"}
          </button>
          <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 10, lineHeight: 1.6 }}>
            Scopes: {phase.pass.scopes.join(", ")} ·{" "}
            {phase.pass.expires_at === null ? "No expiry" : `Expires ${new Date(phase.pass.expires_at).toLocaleDateString()}`}{" "}
            {phase.pass.fee_budget_hbar !== null && `· Fee budget: ${phase.pass.fee_budget_hbar} HBAR`} · Revoke
            anytime from your token card.
          </div>
        </div>
      )}

      {phase.kind !== "done" && (
        <p style={{ fontSize: 12.5, opacity: 0.55, marginTop: 18, lineHeight: 1.6 }}>
          No signup, no sign-in. Tapping Issue is your consent — the pass is
          bound to the wallet you connect and shown once. Execution scopes act
          immediately inside their limits and are logged; page changes still
          need your tap on each approval.
        </p>
      )}
    </main>
  );
}
