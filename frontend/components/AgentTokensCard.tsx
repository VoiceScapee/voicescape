"use client";

/**
 * AgentTokensCard — the human's "agent access" card: list, issue, and revoke
 * capability tokens for keyless AI agents.
 *
 * A capability token is NOT a private key: it cannot sign anything. It only
 * lets a keyless agent SUBMIT page-update proposals to this human's approval
 * inbox — every on-chain write still needs the human's one-tap wallet
 * approval. Tokens are issued with the human's signed-in wallet session as
 * the consent record, and revocation is instant.
 *
 * Security notes for future editors:
 * - The raw token is shown EXACTLY ONCE at issuance. It lives in React state
 *   only: never localStorage, never a cookie, never logged.
 * - Scope strings mirror CAPABILITY_SCOPES in lib/server/capability-tokens.ts
 *   (a server-only module — do not import it here). The API validates scopes;
 *   this list is display + request only.
 */

import { useCallback, useEffect, useState } from "react";
import { restoreSession, SESSION_HEADER } from "@/lib/session-message";
import { SESSION_STORAGE_KEY } from "@/lib/session";
import { fetchWithTimeout } from "@/lib/fetch-timeout";

const SCOPES = [
  {
    id: "page:update:propose",
    label: "Propose page updates",
    blurb: "Submit page changes for your one-tap approval",
  },
  {
    id: "page:read",
    label: "Read page data",
    blurb: "Read your page and directory info",
  },
  {
    id: "media:pin",
    label: "Pin media",
    blurb: "Upload images and media for page drafts",
  },
] as const;

interface TokenRecord {
  id: string;
  label: string;
  scopes: string[];
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
}

type LoadState = "signed-out" | "loading" | "ready" | "error";

function authHeaders(): Record<string, string> | null {
  try {
    const { session } = restoreSession(
      window.localStorage.getItem(SESSION_STORAGE_KEY)
    );
    if (session?.token) return { [SESSION_HEADER]: session.token };
  } catch {
    /* storage unavailable — anonymous */
  }
  return null;
}

function scopeLabel(id: string): string {
  return SCOPES.find((s) => s.id === id)?.label ?? id;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const CARD: React.CSSProperties = {
  border: "1px solid rgba(130, 89, 239, 0.35)",
  borderRadius: 12,
  padding: "12px 14px",
  marginTop: 8,
  background: "rgba(130, 89, 239, 0.08)",
};

const BTN: React.CSSProperties = {
  borderRadius: 8,
  padding: "7px 14px",
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
};

const BTN_PRIMARY: React.CSSProperties = {
  ...BTN,
  background: "#b45cf0",
  border: "none",
  color: "#fff",
};

const BTN_QUIET: React.CSSProperties = {
  ...BTN,
  background: "rgba(130, 89, 239, 0.18)",
  border: "1px solid rgba(130, 89, 239, 0.4)",
  color: "#fff",
};

const BTN_DANGER: React.CSSProperties = {
  ...BTN,
  background: "rgba(255, 90, 90, 0.12)",
  border: "1px solid rgba(255, 90, 90, 0.45)",
  color: "#ff9a9a",
};

const INPUT: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  borderRadius: 8,
  border: "1px solid rgba(130, 89, 239, 0.4)",
  background: "rgba(0, 0, 0, 0.35)",
  color: "#fff",
  padding: "8px 10px",
  fontSize: 13.5,
};

export default function AgentTokensCard() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showIssue, setShowIssue] = useState(false);
  const [issueLabel, setIssueLabel] = useState("");
  const [issueScopes, setIssueScopes] = useState<string[]>(
    SCOPES.map((s) => s.id)
  );
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);

  // The raw token, shown EXACTLY ONCE. React state only — never persisted.
  const [freshToken, setFreshToken] = useState<{ token: string; id: string } | null>(
    null
  );
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const headers = authHeaders();
    if (!headers) {
      setLoadState("signed-out");
      return;
    }
    setLoadState("loading");
    setLoadError(null);
    try {
      const res = await fetchWithTimeout("/api/agents/tokens", 10_000, {
        headers,
      });
      if (res.status === 401) {
        setLoadState("signed-out");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { tokens?: TokenRecord[] };
      setTokens(Array.isArray(data.tokens) ? data.tokens : []);
      setLoadState("ready");
    } catch {
      setLoadError("Couldn't load your tokens — check your connection and try again.");
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleScope = (id: string) =>
    setIssueScopes((cur) =>
      cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id]
    );

  async function issue() {
    setIssueError(null);
    const headers = authHeaders();
    if (!headers) {
      setIssueError("Sign in with your wallet first.");
      return;
    }
    if (!issueLabel.trim()) {
      setIssueError("Give the token a name — e.g. your agent's name.");
      return;
    }
    if (issueScopes.length === 0) {
      setIssueError("Pick at least one permission.");
      return;
    }
    setIssuing(true);
    try {
      const res = await fetchWithTimeout("/api/agents/tokens", 15_000, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ label: issueLabel.trim(), scopes: issueScopes }),
      });
      const data = (await res.json().catch(() => null)) as {
        token?: string;
        id?: string;
        error?: string;
      } | null;
      if (!res.ok || !data?.token || !data?.id) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      // Raw token enters React state only — shown once, never persisted.
      setFreshToken({ token: data.token, id: data.id });
      setCopied(false);
      setCopyFailed(false);
      setShowIssue(false);
      setIssueLabel("");
      setIssueScopes(SCOPES.map((s) => s.id));
      await load();
    } catch (e) {
      setIssueError(
        e instanceof Error ? e.message : "Couldn't issue the token — try again."
      );
    } finally {
      setIssuing(false);
    }
  }

  async function revoke(id: string) {
    const headers = authHeaders();
    if (!headers) {
      setActionError("Sign in with your wallet first.");
      return;
    }
    setRevoking(true);
    setActionError(null);
    try {
      const res = await fetchWithTimeout("/api/agents/tokens", 10_000, {
        method: "DELETE",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      setConfirmRevokeId(null);
      await load();
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "Couldn't revoke the token — try again."
      );
    } finally {
      setRevoking(false);
    }
  }

  async function copyToken() {
    if (!freshToken) return;
    try {
      await navigator.clipboard.writeText(freshToken.token);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }

  function dismissFreshToken() {
    // Clearing React state is the erasure: the raw token is unrecoverable after this.
    setFreshToken(null);
    setCopied(false);
    setCopyFailed(false);
  }

  if (loadState === "signed-out") {
    return (
      <div style={{ ...CARD, opacity: 0.75, fontSize: 13 }}>
        🔑 <strong>Agent tokens</strong> — sign in with your wallet to let a
        keyless AI agent work with your page.
      </div>
    );
  }

  return (
    <div style={CARD}>
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
        🔑 Agent tokens
      </div>

      {loadState === "loading" && (
        <div style={{ fontSize: 13, opacity: 0.65 }}>Loading your tokens…</div>
      )}

      {loadState === "error" && (
        <div style={{ fontSize: 13 }}>
          <span style={{ opacity: 0.75 }}>{loadError}</span>{" "}
          <button type="button" style={BTN_QUIET} onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {loadState === "ready" && (
        <>
          {tokens.length === 0 && !freshToken ? (
            <div style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.9 }}>
              No tokens yet. A token lets your AI agent propose page updates for
              your one-tap approval — <strong>without ever touching a private
              key</strong>. It&apos;s not a key: it can&apos;t sign anything,
              and every on-chain change still needs your wallet tap. Revoke
              anytime — it stops working instantly.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {tokens.map((t) => {
                const expired = Date.now() > t.expires_at;
                const confirming = confirmRevokeId === t.id;
                return (
                  <div
                    key={t.id}
                    style={{
                      border: "1px solid rgba(130, 89, 239, 0.25)",
                      borderRadius: 10,
                      padding: "10px 12px",
                      background: "rgba(0, 0, 0, 0.25)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 8,
                      }}
                    >
                      <span style={{ fontWeight: 800, fontSize: 14, flex: 1 }}>
                        {t.label || "Untitled token"}
                      </span>
                      {expired ? (
                        <span style={{ fontSize: 12, color: "#ff9a9a", fontWeight: 700 }}>
                          Expired
                        </span>
                      ) : (
                        <span style={{ fontSize: 12, opacity: 0.6 }}>
                          Expires {fmtDate(t.expires_at)}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12.5, opacity: 0.75, marginTop: 4 }}>
                      {t.scopes.map(scopeLabel).join(" · ")}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.55, marginTop: 2 }}>
                      {t.last_used_at
                        ? `Last used ${fmtDate(t.last_used_at)}`
                        : "Never used yet"}
                    </div>
                    {!confirming ? (
                      <button
                        type="button"
                        style={{ ...BTN_DANGER, marginTop: 8 }}
                        disabled={revoking}
                        onClick={() => setConfirmRevokeId(t.id)}
                      >
                        Revoke
                      </button>
                    ) : (
                      <div style={{ marginTop: 8, fontSize: 13 }}>
                        <div style={{ marginBottom: 8, lineHeight: 1.5 }}>
                          Revoke <strong>{t.label || "this token"}</strong>?
                          Your agent loses access immediately.
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            type="button"
                            style={BTN_DANGER}
                            disabled={revoking}
                            onClick={() => void revoke(t.id)}
                          >
                            {revoking ? "Revoking…" : "Yes, revoke it"}
                          </button>
                          <button
                            type="button"
                            style={BTN_QUIET}
                            disabled={revoking}
                            onClick={() => setConfirmRevokeId(null)}
                          >
                            Keep it
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {actionError && (
            <div style={{ fontSize: 13, color: "#ff9a9a", marginTop: 8 }}>
              {actionError}
            </div>
          )}

          {/* One-time token reveal — React state only, never persisted. */}
          {freshToken && (
            <div
              style={{
                marginTop: 10,
                border: "1px solid rgba(255, 184, 107, 0.5)",
                borderRadius: 10,
                padding: "12px",
                background: "rgba(255, 184, 107, 0.07)",
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>
                ⚠️ Copy it now — this is the only time you&apos;ll ever see it.
              </div>
              <div
                style={{
                  fontFamily: "monospace",
                  fontSize: 12.5,
                  wordBreak: "break-all",
                  userSelect: "all",
                  background: "rgba(0, 0, 0, 0.45)",
                  border: "1px solid rgba(255, 184, 107, 0.35)",
                  borderRadius: 8,
                  padding: "10px",
                  lineHeight: 1.5,
                }}
              >
                {freshToken.token}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
                <button type="button" style={BTN_PRIMARY} onClick={() => void copyToken()}>
                  {copied ? "Copied ✓" : "Copy token"}
                </button>
                <button type="button" style={BTN_QUIET} onClick={dismissFreshToken}>
                  I&apos;ve saved it
                </button>
              </div>
              {copyFailed && (
                <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 6 }}>
                  Copy didn&apos;t work on this device — long-press the token
                  above to select it manually.
                </div>
              )}
              <div style={{ fontSize: 12.5, opacity: 0.75, marginTop: 8, lineHeight: 1.55 }}>
                Paste it into your agent&apos;s secure credential storage —
                never into chat. Issuing it with your wallet session was the
                approval; the token itself can&apos;t sign anything.
              </div>
            </div>
          )}

          {/* Issue form */}
          {!showIssue && !freshToken && (
            <button
              type="button"
              style={{ ...BTN_PRIMARY, marginTop: 10 }}
              onClick={() => {
                setShowIssue(true);
                setIssueError(null);
              }}
            >
              + New agent token
            </button>
          )}

          {showIssue && (
            <div
              style={{
                marginTop: 10,
                border: "1px solid rgba(130, 89, 239, 0.25)",
                borderRadius: 10,
                padding: "12px",
                background: "rgba(0, 0, 0, 0.25)",
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>
                New token
              </div>
              <input
                style={INPUT}
                placeholder="Name — e.g. your agent's name"
                value={issueLabel}
                maxLength={60}
                onChange={(e) => setIssueLabel(e.target.value)}
                aria-label="Token name"
              />
              <div style={{ fontSize: 12.5, fontWeight: 700, margin: "10px 0 6px", opacity: 0.85 }}>
                What the token allows:
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {SCOPES.map((s) => (
                  <label
                    key={s.id}
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                      fontSize: 13,
                      lineHeight: 1.45,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={issueScopes.includes(s.id)}
                      onChange={() => toggleScope(s.id)}
                      style={{ marginTop: 3, accentColor: "#b45cf0" }}
                    />
                    <span>
                      <strong>{s.label}</strong>
                      <br />
                      <span style={{ opacity: 0.65 }}>{s.blurb}</span>
                    </span>
                  </label>
                ))}
              </div>
              {issueError && (
                <div style={{ fontSize: 13, color: "#ff9a9a", marginTop: 8 }}>
                  {issueError}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  style={BTN_PRIMARY}
                  disabled={issuing}
                  onClick={() => void issue()}
                >
                  {issuing ? "Issuing…" : "Issue token"}
                </button>
                <button
                  type="button"
                  style={BTN_QUIET}
                  disabled={issuing}
                  onClick={() => setShowIssue(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
