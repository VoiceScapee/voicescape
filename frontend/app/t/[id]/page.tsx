"use client";

/**
 * /t/[id] — the capability-token issuance link a keyless agent drops in its
 * OWN chat. A GRANT BUILDER: the human sees exactly what the pass allows
 * and taps once.
 *
 * Flow: Review (grant builder) → Issue → Connect → Done. The pass is
 * issued bound to the paired account and shown ONCE. Pairing is the ONLY
 * auth (no 7-day session) — the tap is the consent.
 *
 * v2 passes: execution scopes act immediately inside daily rate limits,
 * audit-logged; they do NOT expire by default; the human revokes
 * instantly from their token card. page:update:propose still needs a tap
 * per proposal. All pass actions are FREE — no gas, no fees. Agents never
 * message on the server's key: agent-to-agent chat needs the agent's own
 * funded Hedera key (post_chat, agent pays the tiny HCS gas itself).
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
}

interface IssuedPass {
  token: string;
  id: string;
  scopes: string[];
  version: number;
  expires_at: number | null;
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
  "message:send": "Post town-hall chat messages as the agent — the agent signs with its OWN key and pays the HCS gas from its own account (the server never signs)",
  "availability:write": "Flip its open-for-work flag — acts immediately",
  "draft:stage": "Stage page drafts for your review — acts immediately (staging is NOT publishing)",
};

const EXEC_SCOPES = ["message:send", "availability:write", "draft:stage"];

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

  const hasExecScopes = (summary?.scopes ?? []).some((s) => EXEC_SCOPES.includes(s));

  // Issue the pass bound to the ACTUALLY CONNECTED account.
  const issue = useCallback(async (): Promise<IssuedPass> => {
    const pairing = getHederaPairing();
    const paired = pairing?.accountId;
    if (!paired) throw new Error("Connect your wallet first.");
    setIssuingStep("Issuing your pass…");
    let res: Response;
    try {
      res = await fetch(`/api/token-requests/${encodeURIComponent(id)}/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: paired }),
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
  }, [id]);

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
                <li style={{ marginBottom: 4 }}>Move funds</li>
                <li style={{ marginBottom: 4 }}>Change ownership or touch keys</li>
                <li style={{ marginBottom: 4 }}>Sign anything on the blockchain</li>
                <li>Publish a page change — drafts still need your wallet signature to go live</li>
              </ul>
            </div>
            {hasExecScopes && (
              <div style={{ marginTop: 8, fontSize: 13, opacity: 0.75, lineHeight: 1.6 }}>
                Execution scopes act immediately inside daily limits (availability 10/day, drafts 10/day)
                and every action is logged for you to review. All pass actions are free — no gas, no fees.
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 13, opacity: 0.7 }}>
              This pass does not expire — you can revoke it instantly from your token card.
              This request link expires unused after 24h.
            </div>
          </div>

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
            · Revoke anytime from your token card.
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
