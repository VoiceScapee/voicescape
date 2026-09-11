"use client";

/**
 * ReportButton — flag a forum post, chat message, marketplace listing, or
 * user profile for moderator review. Opens a modal with a reason dropdown
 * + details field, posts to /api/townhall/reports (free, signed session
 * required), and shows a confirmation. Reporting is never content-filtered
 * and never charged a dust fee.
 */
import { useState } from "react";
import { useSession } from "@/lib/session";

export type ReportTargetKind = "post" | "chat" | "listing" | "profile";

const REASONS = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment or hate" },
  { value: "scam", label: "Scam or fraud" },
  { value: "illegal", label: "Illegal content" },
  { value: "other", label: "Other" },
] as const;

export default function ReportButton({
  targetKind,
  targetSeq,
  targetId,
}: {
  targetKind: ReportTargetKind;
  /** HCS sequence number of the reported post/chat message. */
  targetSeq?: number;
  /** Listing id (listing reports) or username (profile reports). */
  targetId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(REASONS[0].value);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  let session: ReturnType<typeof useSession> | null = null;
  try {
    session = useSession();
  } catch {
    session = null;
  }
  const signedIn = !!session && session.isAuthenticated;

  const openModal = () => {
    setOpen(true);
    setError(null);
    setDone(false);
  };

  const submit = async () => {
    if (!session || busy) return;
    const detailText = details.trim();
    if (detailText.length < 10) {
      setError("Please describe the issue (at least 10 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/townhall/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...session.authHeader() },
        body: JSON.stringify({
          targetKind,
          ...(targetSeq !== undefined ? { targetSeq } : {}),
          ...(targetId ? { targetId } : {}),
          reason: `[${reason}] ${detailText}`.slice(0, 500),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(typeof body.error === "string" ? body.error : `Report failed (${res.status})`);
      } else {
        setDone(true);
      }
    } catch {
      setError("Could not send the report — check your connection and retry.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="th-action"
        onClick={(e) => {
          // preventDefault: this button can sit inside a card <Link>.
          e.preventDefault();
          e.stopPropagation();
          if (!signedIn) {
            setError(null);
            setOpen(true);
            return;
          }
          openModal();
        }}
        aria-label="Report this content"
        title="Report"
      >
        🚩
      </button>
      {open && (
        <div
          className="th-modal-overlay"
          onClick={(e) => {
            e.preventDefault();
            setOpen(false);
          }}
        >
          <div
            className="th-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Report content"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="th-modal-head">
              <h3>🚩 Report</h3>
              <button type="button" className="th-action" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            {!signedIn ? (
              <p className="th-muted">Sign in with your wallet to file a report. Reporting is free.</p>
            ) : done ? (
              <p style={{ margin: 0 }}>✅ Report submitted — moderators will review it. Thanks for keeping Voicescape safe.</p>
            ) : (
              <>
                <label className="th-muted" htmlFor="th-report-reason" style={{ display: "block", marginBottom: 6 }}>
                  Reason
                </label>
                <select
                  id="th-report-reason"
                  className="vs-input"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  style={{ width: "100%", marginBottom: 10 }}
                >
                  {REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <label className="th-muted" htmlFor="th-report-details" style={{ display: "block", marginBottom: 6 }}>
                  Details <span aria-hidden="true">(min 10 characters)</span>
                </label>
                <textarea
                  id="th-report-details"
                  className="vs-input"
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  rows={4}
                  maxLength={450}
                  placeholder="What makes this content a problem?"
                  style={{ width: "100%", resize: "vertical" }}
                />
                {error && (
                  <p className="th-error" style={{ marginTop: 8 }}>
                    {error}
                  </p>
                )}
                <div className="th-chip-row" style={{ justifyContent: "flex-end" }}>
                  <button type="button" className="vs-btn th-btn-sm" onClick={() => setOpen(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="vs-btn vs-btn-primary th-btn-sm"
                    onClick={submit}
                    disabled={busy}
                  >
                    {busy ? "Sending…" : "Submit report"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
