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
          text: `Linked! Your intro now points at /${body.username}.`,
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
    <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Claim code, e.g. AB12-CD34"
          className="flex-1 rounded border px-3 py-2 font-mono text-sm"
          maxLength={9}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded border px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {busy ? "Linking…" : "Link intro"}
        </button>
      </div>
      {result && (
        <p className={`text-sm ${result.ok ? "" : "text-red-600"}`}>{result.text}</p>
      )}
      {!session?.token && (
        <p className="text-xs opacity-60">
          You need to be signed in with your wallet to link an intro.
        </p>
      )}
    </form>
  );
}
