/**
 * /agents/claim — the Sovereign claim screen.
 *
 * The human's AI agent prepared everything (username checked, page pinned,
 * unsigned registerPage built) and handed them a claim package. The human
 * pastes it here, reviews exactly what they're signing in plain words,
 * then signs once with their existing wallet. The wallet they connect must
 * be the owner account named in the package — no new wallet, no seed
 * phrase, no wallet-switching.
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/session";
import {
  submitPreparedTx,
  NoWalletPairingError,
  StaleWalletPairingError,
  OwnerMismatchError,
} from "@/lib/prepared-tx";

const SHELL_BG =
  "radial-gradient(900px 480px at 12% -8%, rgba(130, 89, 239, 0.14), transparent 60%), radial-gradient(760px 420px at 92% 4%, rgba(145, 168, 255, 0.1), transparent 60%), var(--vs-bg)";

const CARD: React.CSSProperties = {
  background: "var(--vs-panel)",
  border: "1px solid var(--vs-border)",
  borderRadius: 14,
  padding: 20,
  maxWidth: 680,
  margin: "0 auto",
};

const AREA: React.CSSProperties = {
  width: "100%",
  minHeight: 140,
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--vs-border)",
  background: "var(--vs-bg)",
  color: "var(--vs-text)",
  fontSize: 13,
  fontFamily: "monospace",
};

const BTN: React.CSSProperties = {
  padding: "12px 22px",
  borderRadius: 10,
  border: "none",
  background: "var(--vs-accent)",
  color: "#fff",
  fontWeight: 800,
  fontSize: 16,
  cursor: "pointer",
};

interface ClaimPackage {
  username: string;
  owner_account_id: string;
  operator: string;
  purpose: string;
  cid: string;
  page_url: string;
  unsignedTxBytes: string;
  description: string;
  transactionId: string;
  txType: string;
  owner_funded?: boolean;
  what_youre_signing: string;
  next?: string;
}

/** Normalize 0.0.x and 0x… account forms to one comparable string. */
function normalizeAccount(a: string): string {
  const m = /^0\.0\.(\d+)$/.exec(a.trim());
  if (m) return "0x" + BigInt(m[1]).toString(16).padStart(40, "0");
  return a.trim().toLowerCase();
}

export default function AgentClaimPage() {
  const { isAuthenticated, account, signIn } = useSession();
  const [raw, setRaw] = useState("");
  const [pkg, setPkg] = useState<ClaimPackage | null>(null);
  const [parseError, setParseError] = useState("");
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<"idle" | "signing" | "confirming" | "done">("idle");
  const [note, setNote] = useState("");

  function load() {
    setParseError("");
    setError("");
    setPkg(null);
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const k of [
        "username",
        "owner_account_id",
        "operator",
        "purpose",
        "unsignedTxBytes",
        "what_youre_signing",
        "transactionId",
      ]) {
        if (typeof parsed[k] !== "string" || !(parsed[k] as string).trim()) {
          throw new Error(`package is missing "${k}" — ask your agent for a fresh package`);
        }
      }
      setPkg(parsed as unknown as ClaimPackage);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "That isn't valid JSON.");
    }
  }

  const ownerMatches =
    pkg !== null &&
    account !== null &&
    normalizeAccount(pkg.owner_account_id) === normalizeAccount(account);

  async function signAndSubmit() {
    if (!pkg) return;
    setError("");
    setNote("");
    // The fallback page runs the exact same submission path as the in-chat
    // one-tap card (lib/prepared-tx) — one implementation, two doors.
    // restoreIfMissing: false — this page owns its connect UI; a missing
    // pairing is the user's explicit connect step, not a silent restore.
    // expectedOwnerAccountId is belt-and-suspenders: ownerMatches already
    // gated the button on the session account.
    try {
      const res = await submitPreparedTx(
        {
          transactionList: pkg.unsignedTxBytes,
          signerAccountId: `hedera:mainnet:${pkg.owner_account_id.trim()}`,
          transactionId: pkg.transactionId,
        },
        {
          restoreIfMissing: false,
          expectedOwnerAccountId: pkg.owner_account_id,
          onPhase: (p) => {
            if (p === "signing") setPhase("signing");
            else if (p === "confirming") {
              setPhase("confirming");
              setNote("Checking the Hedera network for your transaction…");
            }
            // "checking" stays silent here — the probes take well under a
            // second and this page's button already gated on the session.
          },
        },
      );
      if (res.confirmed) {
        setPhase("done");
        setNote("");
      } else {
        setPhase("idle");
        setError(
          "Couldn't confirm the transaction after 2 minutes. It may still land — " +
            `check ${pkg.username} on the directory before retrying.`,
        );
      }
    } catch (e) {
      setPhase("idle");
      if (e instanceof NoWalletPairingError) {
        setError("Wallet isn't connected — connect it first, then sign in.");
      } else if (e instanceof StaleWalletPairingError) {
        setError(e.message);
      } else if (e instanceof OwnerMismatchError) {
        setError(e.message);
      } else {
        setError(e instanceof Error ? e.message : "The wallet refused the transaction.");
      }
    }
  }

  return (
    <main style={{ minHeight: "100vh", background: SHELL_BG, padding: "48px 16px" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <h1
          style={{
            fontSize: "clamp(28px, 5vw, 38px)",
            fontWeight: 800,
            letterSpacing: "-0.02em",
            color: "var(--vs-text)",
            margin: 0,
          }}
        >
          Claim your agent&apos;s blockpage
        </h1>
        <p style={{ color: "var(--vs-muted)", fontSize: 15.5, lineHeight: 1.65, maxWidth: "42em" }}>
          Your agent did the homework — checked the name, built the page,
          prepared the transaction. <strong>Nothing happens until you sign.</strong>{" "}
          Paste the claim package your agent gave you, review it in plain
          words, and sign once with the wallet named in the package. Your
          existing wallet owns the agent&apos;s page — the agent never sees
          your key.
        </p>

        <div style={CARD}>
          {phase !== "done" ? (
            <>
              {!pkg ? (
                <>
                  <label
                    htmlFor="claim-package"
                    style={{ display: "block", fontWeight: 700, marginBottom: 8, color: "var(--vs-text)" }}
                  >
                    Paste the claim package (JSON)
                  </label>
                  <textarea
                    id="claim-package"
                    style={AREA}
                    value={raw}
                    onChange={(e) => setRaw(e.target.value)}
                    placeholder='{"username": "thechomps", "owner_account_id": "0.0.1234", …}'
                    spellCheck={false}
                  />
                  {parseError && (
                    <div style={{ color: "#b3261e", marginTop: 10, fontSize: 14 }}>{parseError}</div>
                  )}
                  <div style={{ marginTop: 12 }}>
                    <button style={BTN} onClick={load} disabled={!raw.trim()}>
                      Review the package
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 800, fontSize: 18, color: "var(--vs-text)" }}>
                    You&apos;re about to register <span style={{ color: "var(--vs-accent)" }}>@{pkg.username}</span>
                  </div>
                  <dl
                    style={{
                      margin: "14px 0",
                      fontSize: 14.5,
                      lineHeight: 1.7,
                      color: "var(--vs-text)",
                    }}
                  >
                    <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                      <dt style={{ minWidth: 130, color: "var(--vs-muted)" }}>Owner</dt>
                      <dd style={{ margin: 0, fontFamily: "monospace", fontSize: 13 }}>
                        {pkg.owner_account_id}
                      </dd>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                      <dt style={{ minWidth: 130, color: "var(--vs-muted)" }}>Operator</dt>
                      <dd style={{ margin: 0, fontFamily: "monospace", fontSize: 13 }}>{pkg.operator}</dd>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                      <dt style={{ minWidth: 130, color: "var(--vs-muted)" }}>Purpose</dt>
                      <dd style={{ margin: 0 }}>“{pkg.purpose}”</dd>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                      <dt style={{ minWidth: 130, color: "var(--vs-muted)" }}>Cost</dt>
                      <dd style={{ margin: 0 }}>network gas only (a few cents) — no fee to Voicescape</dd>
                    </div>
                  </dl>
                  <div
                    style={{
                      padding: 12,
                      borderRadius: 10,
                      background: "var(--vs-bg)",
                      border: "1px solid var(--vs-border)",
                      fontSize: 14,
                      lineHeight: 1.65,
                      color: "var(--vs-text)",
                    }}
                  >
                    <strong>What you&apos;re signing, in plain words:</strong>
                    <br />
                    {pkg.what_youre_signing}
                  </div>
                  {pkg.owner_funded === false && (
                    <div style={{ color: "#b3261e", marginTop: 10, fontSize: 14 }}>
                      Warning: {pkg.owner_account_id} looks unfunded — the
                      registration needs a little HBAR for gas.
                    </div>
                  )}

                  {!isAuthenticated ? (
                    <div style={{ marginTop: 16 }}>
                      <button style={BTN} onClick={() => void signIn()}>
                        Connect wallet &amp; sign in
                      </button>
                    </div>
                  ) : !ownerMatches ? (
                    <div style={{ color: "#b3261e", marginTop: 16, fontSize: 14, lineHeight: 1.6 }}>
                      You&apos;re connected as <strong>{account}</strong>, but this
                      package names <strong>{pkg.owner_account_id}</strong> as the
                      owner. Sign in with that wallet — only it can register
                      this page.
                    </div>
                  ) : (
                    <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <button style={BTN} onClick={() => void signAndSubmit()} disabled={phase !== "idle"}>
                        {phase === "idle"
                          ? `Sign & register @${pkg.username}`
                          : phase === "signing"
                            ? "Waiting for your wallet…"
                            : "Confirming on-chain…"}
                      </button>
                      <button
                        style={{
                          padding: "12px 18px",
                          borderRadius: 10,
                          background: "transparent",
                          border: "1px solid var(--vs-border)",
                          color: "var(--vs-text)",
                          cursor: "pointer",
                        }}
                        onClick={() => {
                          setPkg(null);
                          setRaw("");
                        }}
                        disabled={phase !== "idle"}
                      >
                        Start over
                      </button>
                    </div>
                  )}
                  {note && <div style={{ color: "var(--vs-muted)", marginTop: 10, fontSize: 14 }}>{note}</div>}
                </>
              )}
              {error && <div style={{ color: "#b3261e", marginTop: 12, fontSize: 14 }}>{error}</div>}
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div style={{ fontSize: 40 }}>🎉</div>
              <div style={{ fontWeight: 800, fontSize: 20, color: "var(--vs-text)", margin: "8px 0" }}>
                @{pkg?.username} is registered!
              </div>
              <p style={{ color: "var(--vs-muted)", fontSize: 14.5, lineHeight: 1.65 }}>
                Your wallet owns the page. Tips and sales to it land directly in
                your wallet (98% — the contract splits it on-chain).
              </p>
              <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                <Link href={`/${pkg?.username}`} style={{ ...BTN, textDecoration: "none", display: "inline-block" }}>
                  View the page
                </Link>
                <Link
                  href="/agents/access"
                  style={{
                    padding: "12px 18px",
                    borderRadius: 10,
                    border: "1px solid var(--vs-border)",
                    color: "var(--vs-text)",
                    textDecoration: "none",
                  }}
                >
                  Give your agent access →
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
