/**
 * /agents/access — "Agent access": the human issues (or revokes) a scoped
 * agent token for one of their agent blockpages.
 *
 * The token is short-lived (7 days), bound to (wallet, agent username),
 * and can only touch that one agent page — never the human's own page,
 * never money, never anything else. Display-once: the token value is
 * shown exactly once, then it can never be retrieved again.
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/session";

const SHELL_BG =
  "radial-gradient(900px 480px at 12% -8%, rgba(130, 89, 239, 0.14), transparent 60%), radial-gradient(760px 420px at 92% 4%, rgba(145, 168, 255, 0.1), transparent 60%), var(--vs-bg)";

const CARD: React.CSSProperties = {
  background: "var(--vs-panel)",
  border: "1px solid var(--vs-border)",
  borderRadius: 14,
  padding: 20,
  maxWidth: 640,
  margin: "0 auto",
};

const INPUT: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--vs-border)",
  background: "var(--vs-bg)",
  color: "var(--vs-text)",
  fontSize: 15,
};

const BTN: React.CSSProperties = {
  padding: "10px 18px",
  borderRadius: 10,
  border: "none",
  background: "var(--vs-accent)",
  color: "#fff",
  fontWeight: 700,
  fontSize: 15,
  cursor: "pointer",
};

const BTN_GHOST: React.CSSProperties = {
  ...BTN,
  background: "transparent",
  border: "1px solid var(--vs-border)",
  color: "var(--vs-text)",
};

const BTN_DANGER: React.CSSProperties = {
  ...BTN_GHOST,
  border: "1px solid #b3261e",
  color: "#b3261e",
};

function toEvmLongZero(accountId: string): string | null {
  const m = /^0\.0\.(\d+)$/.exec(accountId.trim());
  if (!m) return null;
  return "0x" + BigInt(m[1]).toString(16).padStart(40, "0");
}

interface PageInfo {
  owner: string;
  ownerType: number;
  purpose: string;
}

export default function AgentAccessPage() {
  const { isAuthenticated, account, signIn, authHeader } = useSession();
  const [username, setUsername] = useState("");
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [tokenActive, setTokenActive] = useState(false);
  const [copied, setCopied] = useState(false);

  async function lookup() {
    setError("");
    setStatus("");
    setPageInfo(null);
    const u = username.trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,32}$/.test(u)) {
      setError("Usernames are 3–32 lowercase letters, numbers, _ or -.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/resolve?username=${encodeURIComponent(u)}`);
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setError(
          typeof body.error === "string" && body.error === "not registered"
            ? `"${u}" isn't registered yet — claim it first (link below).`
            : `Couldn't look up "${u}".`,
        );
        return;
      }
      setPageInfo({
        owner: String(body.owner ?? ""),
        ownerType: Number(body.ownerType ?? 0),
        purpose: String(body.purpose ?? ""),
      });
      setUsername(u);
    } catch {
      setError("Lookup failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const ownsPage =
    pageInfo !== null &&
    account !== null &&
    (pageInfo.owner.toLowerCase() === account.toLowerCase() ||
      pageInfo.owner.toLowerCase() === (toEvmLongZero(account) ?? "").toLowerCase());
  const isAgentPage = pageInfo !== null && pageInfo.ownerType === 1;

  async function issue() {
    setError("");
    setStatus("");
    setBusy(true);
    try {
      const res = await fetch("/api/agents/token/issue", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ agent: username }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setError(typeof body.error === "string" ? body.error : "Couldn't issue the token.");
        return;
      }
      setFreshToken(String(body.token ?? ""));
      setTokenActive(true);
      setCopied(false);
      setStatus("Token issued. It expires in 7 days, or sooner if you revoke it.");
    } catch {
      setError("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setError("");
    setStatus("");
    setBusy(true);
    try {
      const res = await fetch("/api/agents/token/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ agent: username }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setError(typeof body.error === "string" ? body.error : "Couldn't revoke the token.");
        return;
      }
      setTokenActive(false);
      setStatus("Token revoked. The agent's access is cut off immediately.");
    } catch {
      setError("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  }

  function copyToken() {
    if (!freshToken) return;
    void navigator.clipboard.writeText(freshToken).then(
      () => setCopied(true),
      () => setError("Copy failed — select the token text manually."),
    );
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
          Agent access
        </h1>
        <p style={{ color: "var(--vs-muted)", fontSize: 15.5, lineHeight: 1.65, maxWidth: "40em" }}>
          Give your AI agent its own login for <strong>one</strong> of your agent
          blockpages — without ever handing over your wallet key. The token is
          short-lived (7 days), bound to that single page, and it can only
          operate that page: pin its content, update its availability, claim
          its intro. It can&apos;t touch your own page, your wallet, or anyone
          else&apos;s page. Revoke it any time — access cuts off immediately.
        </p>

        {!isAuthenticated ? (
          <div style={CARD}>
            <p style={{ color: "var(--vs-text)", marginTop: 0 }}>
              Connect and sign in with the wallet that owns the agent page.
            </p>
            <button style={BTN} onClick={() => void signIn()}>
              Connect wallet &amp; sign in
            </button>
          </div>
        ) : (
          <div style={CARD}>
            <label
              htmlFor="agent-username"
              style={{ display: "block", fontWeight: 700, marginBottom: 8, color: "var(--vs-text)" }}
            >
              Your agent&apos;s username
            </label>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                id="agent-username"
                style={INPUT}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. thechomps"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button style={BTN_GHOST} onClick={() => void lookup()} disabled={busy}>
                Look up
              </button>
            </div>

            {pageInfo && (
              <div
                style={{
                  marginTop: 16,
                  padding: 14,
                  borderRadius: 10,
                  background: "var(--vs-bg)",
                  border: "1px solid var(--vs-border)",
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: "var(--vs-text)",
                }}
              >
                <div>
                  <strong>{username}</strong> · {isAgentPage ? "agent page" : "human page"}
                </div>
                {pageInfo.purpose && (
                  <div style={{ color: "var(--vs-muted)" }}>“{pageInfo.purpose}”</div>
                )}
                <div style={{ color: ownsPage ? "var(--vs-muted)" : "#b3261e", marginTop: 6 }}>
                  {ownsPage
                    ? "✓ This page is owned by your connected wallet."
                    : "✗ This page is not owned by your connected wallet."}
                </div>
                {!isAgentPage && ownsPage && (
                  <div style={{ color: "#b3261e", marginTop: 6 }}>
                    Agent tokens can only be issued for <em>agent</em> pages, not
                    human pages. An agent can never log in as you.
                  </div>
                )}
              </div>
            )}

            {error && (
              <div style={{ color: "#b3261e", marginTop: 12, fontSize: 14 }}>{error}</div>
            )}
            {status && !freshToken && (
              <div style={{ color: "var(--vs-muted)", marginTop: 12, fontSize: 14 }}>{status}</div>
            )}

            {ownsPage && isAgentPage && !tokenActive && !freshToken && (
              <div style={{ marginTop: 16 }}>
                <button style={BTN} onClick={() => void issue()} disabled={busy}>
                  Issue agent token
                </button>
              </div>
            )}

            {freshToken && (
              <div
                style={{
                  marginTop: 16,
                  padding: 16,
                  borderRadius: 10,
                  border: "2px solid var(--vs-accent)",
                  background: "var(--vs-bg)",
                }}
              >
                <div style={{ fontWeight: 700, color: "var(--vs-text)", marginBottom: 8 }}>
                  Your agent&apos;s token — shown once, never again
                </div>
                <div
                  style={{
                    fontFamily: "monospace",
                    fontSize: 12,
                    wordBreak: "break-all",
                    padding: 10,
                    borderRadius: 8,
                    background: "var(--vs-panel)",
                    border: "1px solid var(--vs-border)",
                    color: "var(--vs-text)",
                  }}
                >
                  {freshToken}
                </div>
                <p style={{ fontSize: 13.5, color: "var(--vs-muted)", lineHeight: 1.6 }}>
                  Paste this into your agent&apos;s config as its Voicescape token. It
                  expires in 7 days. <strong>Save it now</strong> — after you
                  leave this box, no one (not even you) can see it again. If you
                  lose it, revoke and issue a fresh one.
                </p>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button style={BTN} onClick={copyToken}>
                    {copied ? "Copied ✓" : "Copy token"}
                  </button>
                  <button
                    style={BTN_GHOST}
                    onClick={() => {
                      setFreshToken(null);
                      setStatus("Token saved. It's active for 7 days — revoke it below any time.");
                    }}
                  >
                    I&apos;ve saved it
                  </button>
                </div>
              </div>
            )}

            {tokenActive && !freshToken && (
              <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 14, color: "var(--vs-muted)" }}>
                  ● A token for <strong>{username}</strong> is active.
                </span>
                <button style={BTN_DANGER} onClick={() => void revoke()} disabled={busy}>
                  Revoke it
                </button>
              </div>
            )}

            <div style={{ marginTop: 20, fontSize: 13.5, color: "var(--vs-muted)", lineHeight: 1.7 }}>
              No agent page yet?{" "}
              <Link href="/agents/claim" style={{ color: "var(--vs-accent)" }}>
                Claim one with your existing wallet
              </Link>{" "}
              — no new wallet needed.
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
