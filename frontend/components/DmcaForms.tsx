"use client";

/**
 * /dmca — copyright notice + counter-notice intake.
 *
 * Two forms (takedown notice / counter-notice) that POST to /api/dmca.
 * No wallet sign-in is required to file — the reporter may not be a
 * Voicescape user. Submitting one notice per material keeps the intake
 * clean; the designated-agent contact is shown for anyone who prefers
 * to write in directly.
 */

import { useState } from "react";

interface FieldDef {
  name: string;
  label: string;
  hint: string;
  optional?: boolean;
}

const NOTICE_FIELDS: FieldDef[] = [
  { name: "work", label: "The copyrighted work", hint: "Describe the work you own (title, author, where it was published)." },
  { name: "location", label: "Where the infringing material is", hint: "A link to the blockpage, post, or listing is enough." },
  { name: "contactName", label: "Your full name", hint: "Required by law on a takedown notice." },
  { name: "contact", label: "How to reach you", hint: "Email or phone — we need this to follow up." },
  { name: "reportedWallet", label: "Reporter's wallet (if known)", hint: "The wallet that posted the material, e.g. 0.0.xxxxx.", optional: true },
  { name: "signature", label: "Your signature", hint: "Type your full name as your electronic signature." },
];

const COUNTER_FIELDS: FieldDef[] = [
  { name: "work", label: "The material that was removed", hint: "Describe what was taken down." },
  { name: "location", label: "Where it was", hint: "The link it lived at, if you still have it." },
  { name: "contactName", label: "Your full name", hint: "" },
  { name: "contact", label: "How to reach you", hint: "Email or phone." },
  { name: "signature", label: "Your signature", hint: "Type your full name as your electronic signature." },
];

function NoticeForm({
  kind,
  fields,
  intro,
  perjury,
}: {
  kind: "notice" | "counter-notice";
  fields: FieldDef[];
  intro: string;
  perjury: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [goodFaith, setGoodFaith] = useState(false);
  const [perjuryOk, setPerjuryOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const set = (name: string, v: string) => setValues((p) => ({ ...p, [name]: v }));

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/dmca", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          ...Object.fromEntries(fields.map((f) => [f.name, values[f.name] ?? ""])),
          goodFaith,
          perjuryStatement: perjury ? perjuryOk : undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const details = Array.isArray(j.details)
          ? j.details.map((d: { message: string }) => d.message).join(" · ")
          : j.error;
        throw new Error(details || "Submission failed — please try again.");
      }
      setDone(
        `Received ${j.receivedAt ? `at ${new Date(j.receivedAt).toLocaleString()}` : "—"} · reference ${j.id}. We review notices promptly and will act as required by law.`,
      );
      setValues({});
      setGoodFaith(false);
      setPerjuryOk(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submission failed — please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="vs-card" style={{ padding: 20, marginTop: 16 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>
        {kind === "notice" ? "File a takedown notice" : "File a counter-notice"}
      </h2>
      <p style={{ fontSize: 14, opacity: 0.85, margin: "0 0 16px" }}>{intro}</p>
      {fields.map((f) => (
        <label key={f.name} style={{ display: "block", marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
            {f.label}
            {f.optional ? <span style={{ fontWeight: 400, opacity: 0.7 }}> (optional)</span> : null}
          </div>
          <input
            type="text"
            value={values[f.name] ?? ""}
            onChange={(e) => set(e.target.name, e.target.value)}
            name={f.name}
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
          {f.hint ? <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{f.hint}</div> : null}
        </label>
      ))}
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", margin: "12px 0", fontSize: 14 }}>
        <input type="checkbox" checked={goodFaith} onChange={(e) => setGoodFaith(e.target.checked)} />
        <span>
          I state in good faith that the use of the material described above is not authorized by the
          copyright owner, its agent, or the law.
        </span>
      </label>
      {perjury ? (
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", margin: "0 0 12px", fontSize: 14 }}>
          <input type="checkbox" checked={perjuryOk} onChange={(e) => setPerjuryOk(e.target.checked)} />
          <span>
            Under penalty of perjury, I state that the information in this notice is accurate and that I
            am the copyright owner or am authorized to act on the owner&apos;s behalf.
          </span>
        </label>
      ) : null}
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
        {busy ? "Submitting…" : kind === "notice" ? "Submit takedown notice" : "Submit counter-notice"}
      </button>
    </section>
  );
}

export default function DmcaForms({ agentContact }: { agentContact: string }) {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "32px 16px 64px" }}>
      <h1 style={{ fontSize: 28, margin: "0 0 8px" }}>Copyright</h1>
      <p style={{ fontSize: 15, opacity: 0.85, lineHeight: 1.6 }}>
        Voicescape respects copyright. If you believe material on the platform infringes your
        copyright, file a notice below or write to our designated copyright agent at{" "}
        <strong>{agentContact}</strong> — until the official agent is registered with the U.S.
        Copyright Office, that channel is the designated contact. Repeat infringers have their
        access terminated.
      </p>
      <p style={{ fontSize: 13, opacity: 0.7, lineHeight: 1.6 }}>
        Filing a false notice can have legal consequences. If your own content was removed by
        mistake, use the counter-notice form instead — we restore material 10–14 business days
        after a valid counter-notice unless the complainant files suit.
      </p>
      <NoticeForm
        kind="notice"
        fields={NOTICE_FIELDS}
        perjury
        intro="Tell us what was infringed and where it is. We act on complete notices promptly — the clock starts the moment we receive yours."
      />
      <NoticeForm
        kind="counter-notice"
        fields={COUNTER_FIELDS}
        perjury={false}
        intro="If your content was taken down and you believe the removal was a mistake or misidentification, counter here."
      />
    </main>
  );
}
