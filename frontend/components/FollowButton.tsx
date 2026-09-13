"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useSession } from "@/lib/session";
import { WalletConnect } from "@/components/WalletConnect";

/**
 * Follow / Following toggle for blockpages (public, non-owner view).
 *
 * - Requires a signed-in wallet: tapping Follow while signed out expands a
 *   real wallet connect prompt (the proven WalletConnect widget); the
 *   follow itself is always wallet-signed via x-vs-session.
 * - Follower count is public (GET /api/follows/count); the per-wallet
 *   following list stays private (session-gated GET /api/follows).
 */
export function FollowButton({ username }: { username: string }) {
  const { t } = useLanguage();
  const { isAuthenticated, authHeader } = useSession();
  const [following, setFollowing] = useState<boolean | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);

  const load = useCallback(async () => {
    // Follower count is public — always load it.
    try {
      const cRes = await fetch(`/api/follows/count?username=${encodeURIComponent(username)}`, {
        cache: "no-store",
      });
      if (cRes.ok) {
        const cJson = (await cRes.json()) as { followers?: number };
        if (typeof cJson.followers === "number") setCount(cJson.followers);
      }
    } catch {
      /* count is a nicety — the button still works without it */
    }
    // Button state is private to the wallet — needs the session.
    if (!isAuthenticated) {
      setFollowing(null);
      return;
    }
    try {
      const res = await fetch("/api/follows", {
        headers: { ...authHeader() },
        cache: "no-store",
      });
      if (res.ok) {
        const json = (await res.json()) as { following?: string[] };
        setFollowing(Array.isArray(json.following) && json.following.includes(username));
      }
    } catch {
      /* leave state unknown rather than lie about it */
    }
  }, [username, isAuthenticated, authHeader]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(async () => {
    if (!isAuthenticated) {
      setShowConnect((v) => !v);
      return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/follows", {
        method: following ? "DELETE" : "POST",
        headers: { "content-type": "application/json", ...authHeader() },
        body: JSON.stringify({ username }),
      });
      const json = (await res.json()) as { following?: string[]; error?: string };
      if (!res.ok) throw new Error(json.error || `server responded ${res.status}`);
      setFollowing(Array.isArray(json.following) && json.following.includes(username));
      setShowConnect(false);
      // Refresh the public count after the change.
      const cRes = await fetch(`/api/follows/count?username=${encodeURIComponent(username)}`, {
        cache: "no-store",
      });
      if (cRes.ok) {
        const cJson = (await cRes.json()) as { followers?: number };
        if (typeof cJson.followers === "number") setCount(cJson.followers);
      }
    } catch {
      setError(t("follow.error"));
    } finally {
      setBusy(false);
    }
  }, [isAuthenticated, busy, following, authHeader, username, t]);

  const countText =
    count === null ? "" : t("follow.followers").replace("{n}", String(count));

  return (
    <div style={{ margin: "14px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          onClick={() => void toggle()}
          disabled={busy}
          className={following ? "vs-btn vs-btn-ghost" : "vs-btn vs-btn-primary"}
          style={{ padding: "9px 22px", fontSize: 14 }}
          aria-pressed={following === true}
        >
          {busy ? "…" : following ? `✓ ${t("follow.following")}` : t("follow.follow")}
        </button>
        {countText && (
          <span className="th-muted" style={{ fontSize: "0.9rem" }}>
            {countText}
          </span>
        )}
      </div>
      {error && (
        <p style={{ color: "#f87171", fontSize: 13, margin: "8px 0 0" }} role="alert">
          {error}
        </p>
      )}
      {!isAuthenticated && showConnect && (
        <div
          style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 12,
            border: "1px solid var(--vs-border)",
            background: "var(--vs-glass)",
          }}
        >
          <p className="th-muted" style={{ fontSize: "0.9rem", margin: "0 0 10px" }}>
            {t("follow.signInPrompt")}
          </p>
          <WalletConnect />
        </div>
      )}
    </div>
  );
}
