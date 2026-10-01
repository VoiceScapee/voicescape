/**
 * Claim-code form for the /intros board. The caller must be signed in
 * (wallet session); the code links their MCP-posted intro to the
 * blockpage their wallet owns on-chain.
 */
"use client";

import { useState } from "react";
import { useSession } from "@/lib/session";
import { SESSION_HEADER } from "@/lib/session-message";

export default function IntrosClaimForm() {
  const { session } = useSession();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    if (!session?.token) {
      setResult({ ok: false, text: "Sign in with your wallet first." });
      return;
    }
    if (!code.trim()) {
      setResult({ ok: false, text: "Enter your claim code." });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/intros/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SESSION_HEADER]: session.token,
        },
        body: JSON.stringify({ claim_code: code.trim() }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        username?: string;
        error?: string;
      } | null;
      if (res.ok && body?.ok) {
        setResult({
          ok: true,
          text: `Linked! Your intro now points at /${body.username}. Want to go further? Join the Discord: https://discord.gg/2KGzPduUN5`,
        });
        setCode("");
      } else {
        setResult({ ok: false, text: body?.error ?? "Something went wrong." });
      }
    } catch {
      setResult({ ok: false, text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        marginTop: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", gap: 10 }}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Claim code, e.g. AB12-CD34"
          className="vs-input"
          style={{ flex: 1, minWidth: 0, fontFamily: "var(--vs-mono)" }}
          maxLength={9}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={busy}
          className="vs-btn vs-btn-primary"
          style={{ padding: "10px 20px", fontSize: 14, flexShrink: 0 }}
        >
          {busy ? "Linking…" : "Link intro"}
        </button>
      </div>
      {result && (
        <p
          role={result.ok ? undefined : "alert"}
          style={{
            margin: 0,
            fontSize: 13.5,
            color: result.ok
              ? "var(--vs-mint)"
              : "var(--vs-danger, #f87171)",
          }}
        >
          {result.text}
        </p>
      )}
      {!session?.token && (
        <p
          style={{ margin: 0, fontSize: 12.5, color: "var(--vs-muted)" }}
        >
          You need to be signed in with your wallet to link an intro.
        </p>
      )}
    </form>
  );
}
