"use client";

/**
 * /privacy-request — data-rights request form (GDPR/CCPA).
 *
 * Requires a signed wallet session: the request is keyed to the wallet
 * address so it can be answered. No email, name, or other new PII is
 * collected.
 */

import { useState } from "react";
import { useSession } from "@/lib/session";

const KINDS = [
  { value: "access", label: "Access — see what data you hold about me" },
  { value: "correction", label: "Correction — fix something inaccurate" },
  { value: "deletion", label: "Deletion — delete what you can" },
  { value: "restriction", label: "Restriction — limit how you use my data" },
] as const;

export default function PrivacyRequestPage() {
  const session = useSession();
  const signedIn = !!session && session.isAuthenticated;
  const authHeaders = session?.authHeader() ?? {};
  const [kind, setKind] = useState<string>("access");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !session) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/privacy-request", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify({ kind, details }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "Submission failed — please try again.");
      setDone(`Recorded ${j.receivedAt ? `at ${new Date(j.receivedAt).toLocaleString()}` : "—"} · reference ${j.id}. ${j.note ?? ""}`);
      setDetails("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submission failed — please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "32px 16px 64px" }}>
      <h1 style={{ fontSize: 28, margin: "0 0 8px" }}>Your data rights</h1>
      <p style={{ fontSize: 15, opacity: 0.85, lineHeight: 1.6 }}>
        Depending on where you live, you can ask to see, correct, delete, or restrict the personal
        data Voicescape holds about you. We hold almost nothing — most requests are answered with a
        simple confirmation. On-chain data can&apos;t be changed by us: it belongs to the Hedera
        network, not to Voicescape.
      </p>
      {!signedIn ? (
        <p className="vs-card" style={{ padding: 16, fontSize: 14 }}>
          Sign in with your wallet to submit a request — we key it to your wallet address so we can
          answer it, and we collect nothing else.
        </p>
      ) : (
        <section className="vs-card" style={{ padding: 20, marginTop: 16 }}>
          <label style={{ display: "block", marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>What would you like?</div>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "rgba(255,255,255,0.04)",
                color: "inherit",
                fontSize: 14,
              }}
            >
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "block", marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>
              Anything we should know? <span style={{ fontWeight: 400, opacity: 0.7 }}>(optional)</span>
            </div>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={3}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "rgba(255,255,255,0.04)",
                color: "inherit",
                fontSize: 14,
              }}
            />
          </label>
          {error ? <p style={{ color: "#ff9a9a", fontSize: 14 }}>{error}</p> : null}
          {done ? <p style={{ color: "#9ae6a0", fontSize: 14 }}>{done}</p> : null}
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            style={{
              padding: "10px 18px",
              borderRadius: 10,
              border: "none",
              background: "#2dd4bf",
              color: "#06281f",
              fontWeight: 700,
              fontSize: 15,
              cursor: busy ? "wait" : "pointer",
            }}
          >
            {busy ? "Submitting…" : "Submit request"}
          </button>
        </section>
      )}
    </main>
  );
}
