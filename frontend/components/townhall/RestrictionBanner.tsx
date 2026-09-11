"use client";

/**
 * RestrictionBanner — shows the signed-in wallet's own enforcement state
 * at the top of the Town Hall: warnings, timeouts, and bans (temporary
 * or permanent), with an appeal flow for restricted users. Fail-open:
 * when the status API is unreachable the banner simply doesn't render.
 */
import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/lib/session";

type Status = "clean" | "warned" | "timed-out" | "temp-banned" | "banned";

interface RestrictionState {
  status: Status;
  reason: string | null;
  remainingMs: number | null;
  expiresAt: number | null;
}

function formatExpiry(expiresAt: number | null, remainingMs: number | null): string {
  if (expiresAt) {
    return new Date(expiresAt).toLocaleString();
  }
  if (remainingMs !== null) {
    const mins = Math.max(1, Math.ceil(remainingMs / 60000));
    if (mins < 60) return `in ${mins}m`;
    const h = Math.floor(mins / 60);
    if (h < 48) return `in ${h}h`;
    return `in ${Math.floor(h / 24)}d`;
  }
  return "";
}

export default function RestrictionBanner() {
  const [state, setState] = useState<RestrictionState | null>(null);
  const [appealOpen, setAppealOpen] = useState(false);
  const [appealText, setAppealText] = useState("");
  const [appealBusy, setAppealBusy] = useState(false);
  const [appealError, setAppealError] = useState<string | null>(null);
  const [appealDone, setAppealDone] = useState(false);

  let session: ReturnType<typeof useSession> | null = null;
  try {
    session = useSession();
  } catch {
    session = null;
  }
  const sessionReady = !!session && session.status !== "loading";
  const signedIn = !!session && session.isAuthenticated;

  const load = useCallback(() => {
    if (!sessionReady || !signedIn || !session) {
      setState(null);
      return;
    }
    let live = true;
    fetch("/api/townhall/me/restriction", { headers: { ...session.authHeader() } })
      .then(async (res) => {
        if (!live || !res.ok) return;
        const body = (await res.json().catch(() => null)) as RestrictionState | null;
        if (live && body && typeof body.status === "string") setState(body);
      })
      .catch(() => {
        // Fail-open: an unreadable status API must not break the page.
      });
    return () => {
      live = false;
    };
  }, [sessionReady, signedIn, session]);

  useEffect(() => {
    const cleanup = load();
    return cleanup;
  }, [load]);

  const submitAppeal = async () => {
    if (!session || appealBusy) return;
    const text = appealText.trim();
    if (text.length < 20) {
      setAppealError("Please explain your case (at least 20 characters).");
      return;
    }
    setAppealBusy(true);
    setAppealError(null);
    try {
      const res = await fetch("/api/townhall/appeals", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...session.authHeader() },
        body: JSON.stringify({ reason: text.slice(0, 500) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setAppealError(typeof body.error === "string" ? body.error : `Appeal failed (${res.status})`);
      } else {
        setAppealDone(true);
      }
    } catch {
      setAppealError("Could not send the appeal — check your connection and retry.");
    } finally {
      setAppealBusy(false);
    }
  };

  if (!state || state.status === "clean") return null;

  const bannerStyle: React.CSSProperties = {
    padding: "10px 16px",
    fontSize: "0.92rem",
    textAlign: "center",
  };
  const appealBtn = (
    <button
      type="button"
      className="vs-btn th-btn-sm"
      style={{ marginLeft: 10 }}
      onClick={() => {
        setAppealOpen(true);
        setAppealError(null);
        setAppealDone(false);
      }}
    >
      Appeal
    </button>
  );

  let banner: React.ReactNode = null;
  if (state.status === "warned") {
    banner = (
      <div style={{ ...bannerStyle, background: "rgba(255,193,7,.12)", borderBottom: "1px solid rgba(255,193,7,.4)" }}>
        ⚠️ You&apos;ve received a warning{state.reason ? `: “${state.reason}”` : "."} Further violations may
        result in a timeout or ban.
      </div>
    );
  } else if (state.status === "timed-out") {
    banner = (
      <div style={{ ...bannerStyle, background: "rgba(255,152,0,.12)", borderBottom: "1px solid rgba(255,152,0,.4)" }}>
        ⏱️ You&apos;re timed out until {formatExpiry(state.expiresAt, state.remainingMs)}.
        {state.reason ? ` Reason: “${state.reason}”` : ""}
        {appealBtn}
      </div>
    );
  } else {
    const temp = state.status === "temp-banned";
    banner = (
      <div style={{ ...bannerStyle, background: "rgba(244,67,54,.12)", borderBottom: "1px solid rgba(244,67,54,.4)" }}>
        🚫 Your account is {temp ? `temporarily banned (until ${formatExpiry(state.expiresAt, state.remainingMs)})` : "permanently banned"}.
        {state.reason ? ` Reason: “${state.reason}”` : ""}
        {appealBtn}
      </div>
    );
  }

  return (
    <>
      {banner}
      {appealOpen && (
        <div className="th-modal-overlay" onClick={() => setAppealOpen(false)}>
          <div
            className="th-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Appeal restriction"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="th-modal-head">
              <h3>📝 Appeal</h3>
              <button type="button" className="th-action" onClick={() => setAppealOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            {appealDone ? (
              <p style={{ margin: 0 }}>
                ✅ Appeal submitted — a moderator will review it. You can only have one pending appeal at a
                time.
              </p>
            ) : (
              <>
                <label className="th-muted" htmlFor="th-appeal-text" style={{ display: "block", marginBottom: 6 }}>
                  Your statement <span aria-hidden="true">(min 20 characters)</span>
                </label>
                <textarea
                  id="th-appeal-text"
                  className="vs-input"
                  value={appealText}
                  onChange={(e) => setAppealText(e.target.value)}
                  rows={5}
                  maxLength={500}
                  placeholder="Explain why the restriction should be lifted…"
                  style={{ width: "100%", resize: "vertical" }}
                />
                {appealError && (
                  <p className="th-error" style={{ marginTop: 8 }}>
                    {appealError}
                  </p>
                )}
                <div className="th-chip-row" style={{ justifyContent: "flex-end" }}>
                  <button type="button" className="vs-btn th-btn-sm" onClick={() => setAppealOpen(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="vs-btn vs-btn-primary th-btn-sm"
                    onClick={submitAppeal}
                    disabled={appealBusy}
                  >
                    {appealBusy ? "Sending…" : "Submit appeal"}
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
