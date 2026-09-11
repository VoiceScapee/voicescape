"use client";

/**
 * Moderation dashboard (/mod). Mod-only — every API enforces the mod
 * check server-side (TOWNHALL_MODS username or TOWNHALL_MOD_WALLETS /
 * MOD_WALLET_ADDRESSES wallet), so non-mods see a denial even if they
 * navigate here directly.
 *
 * Tabs: Reports Queue | Active Warnings | Timeouts & Bans | Appeals.
 */
import { useCallback, useEffect, useState } from "react";
import { getAuthHeaders } from "@/lib/auth-client";
import { useWriteGate } from "@/components/townhall/useTownhall";

type Tab = "reports" | "warnings" | "restrictions" | "appeals";

interface Report {
  seq: number;
  targetKind: "post" | "chat" | "listing" | "profile";
  targetSeq: number | null;
  targetId: string | null;
  reason: string;
  reporter: string;
  ts: string;
}

interface Warn {
  wallet: string;
  username: string | null;
  reason: string;
  warnedBy: string;
  ts: string;
}

interface Ban {
  wallet: string;
  username: string | null;
  reason: string;
  bannedBy: string;
  expiresAt: number | null;
  ts: string;
}

interface Timeout {
  wallet: string;
  username: string | null;
  reason: string;
  timedOutBy: string;
  durationMinutes: number;
  expiresAt: number;
  ts: string;
}

interface Appeal {
  wallet: string;
  reporter: string;
  reason: string;
  ts: string;
  restriction: {
    status: string;
    reason: string | null;
    remainingMs: number | null;
    expiresAt: number | null;
  } | null;
}

const TABS: { id: Tab; label: string }[] = [
  { id: "reports", label: "🚩 Reports Queue" },
  { id: "warnings", label: "⚠️ Active Warnings" },
  { id: "restrictions", label: "⏱️ Timeouts & Bans" },
  { id: "appeals", label: "📝 Appeals" },
];

const DISMISS_KEY = "vs-mod-dismissed-reports";

function loadDismissed(): Set<number> {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    if (raw) return new Set(JSON.parse(raw) as number[]);
  } catch {
    // ignore
  }
  return new Set();
}

function targetLabel(r: Report): string {
  if (r.targetKind === "post") return `post #${r.targetSeq}`;
  if (r.targetKind === "chat") return `chat msg #${r.targetSeq}`;
  if (r.targetKind === "listing") return `listing ${r.targetId}`;
  return `profile @${r.targetId}`;
}

async function authed<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", accept: "application/json", ...getAuthHeaders(), ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  return body as T;
}

export default function ModDashboardPage() {
  const { isAuthenticated, sessionReady } = useWriteGate();
  const { username: me } = useWriteGate();
  const [tab, setTab] = useState<Tab>("reports");
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [warnings, setWarnings] = useState<Warn[]>([]);
  const [bans, setBans] = useState<Ban[]>([]);
  const [timeouts, setTimeouts] = useState<Timeout[]>([]);
  const [appeals, setAppeals] = useState<Appeal[]>([]);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  // Mod identity for the mod-gated handlers: registered username when the
  // mod acts under one (TOWNHALL_MODS path), empty for pure wallet mods.
  const modIdentity = { username: me ?? "" };

  // Username-only moderators (TOWNHALL_MODS without a wallet in the mod
  // wallet lists) must identify on GETs too — the session alone carries
  // only the wallet. Wallet-configured mods are unaffected.
  const withModUser = (url: string) => {
    if (!me) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}username=${encodeURIComponent(me)}`;
  };

  const load = useCallback(async () => {
    if (!sessionReady || !isAuthenticated) return;
    setLoading(true);
    setError(null);
    setDenied(false);
    try {
      const [rq, wq, bq, aq] = await Promise.all([
        authed<{ reports?: Report[] }>(withModUser(`/api/townhall/reports`)),
        authed<{ warnings?: Warn[] }>(withModUser(`/api/townhall/warnings`)),
        authed<{ bans?: Ban[]; timeouts?: Timeout[] }>(withModUser(`/api/townhall/bans`)),
        authed<{ appeals?: Appeal[] }>(withModUser(`/api/townhall/appeals`)),
      ]);
      setReports(Array.isArray(rq.reports) ? rq.reports : []);
      setWarnings(Array.isArray(wq.warnings) ? wq.warnings : []);
      setBans(Array.isArray(bq.bans) ? bq.bans : []);
      setTimeouts(Array.isArray(bq.timeouts) ? bq.timeouts : []);
      setAppeals(Array.isArray(aq.appeals) ? aq.appeals : []);
      setDismissed(loadDismissed());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/403|moderator access/i.test(msg)) setDenied(true);
      else setError(msg);
    } finally {
      setLoading(false);
    }
  }, [sessionReady, isAuthenticated, me]);

  useEffect(() => {
    void load();
  }, [load]);

  const dismissReport = (seq: number) => {
    const next = new Set(dismissed);
    next.add(seq);
    setDismissed(next);
    try {
      window.localStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
    } catch {
      // ignore
    }
  };

  const visibleReports = reports.filter((r) => !dismissed.has(r.seq));

  if (!sessionReady) return <p className="th-muted">Loading…</p>;
  if (!isAuthenticated) {
    return (
      <div className="th-page">
        <h1>🛡️ Moderation</h1>
        <p className="th-muted">Sign in with a moderator wallet to access the moderation dashboard.</p>
      </div>
    );
  }
  if (denied) {
    return (
      <div className="th-page">
        <h1>🛡️ Moderation</h1>
        <p className="th-error">Moderator access required — this wallet is not a moderator.</p>
      </div>
    );
  }

  return (
    <div className="th-page">
      <div className="th-between" style={{ alignItems: "center" }}>
        <h1>🛡️ Moderation</h1>
        <button type="button" className="vs-btn th-btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>
      {error && <p className="th-error">{error}</p>}
      <div className="th-chip-row" role="tablist" aria-label="Moderation sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`vs-btn th-btn-sm${tab === t.id ? " vs-btn-primary" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "reports" && visibleReports.length > 0 && ` (${visibleReports.length})`}
            {t.id === "appeals" && appeals.length > 0 && ` (${appeals.length})`}
          </button>
        ))}
      </div>

      {tab === "reports" && (
        <ReportQueue
          reports={visibleReports}
          modIdentity={modIdentity}
          onDismiss={dismissReport}
          onActed={() => void load()}
        />
      )}
      {tab === "warnings" && (
        <WarningsList warnings={warnings} onLifted={() => void load()} />
      )}
      {tab === "restrictions" && (
        <RestrictionsList bans={bans} timeouts={timeouts} onLifted={() => void load()} />
      )}
      {tab === "appeals" && (
        <AppealsList appeals={appeals} onResolved={() => void load()} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reports queue                                                       */
/* ------------------------------------------------------------------ */

function ReportQueue({
  reports,
  modIdentity,
  onDismiss,
  onActed,
}: {
  reports: Report[];
  modIdentity: { username: string };
  onDismiss: (seq: number) => void;
  onActed: () => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  if (reports.length === 0) {
    return <p className="th-muted" style={{ marginTop: 16 }}>No pending reports. 🎉</p>;
  }
  return (
    <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
      {reports.map((r) => (
        <article key={r.seq} className="th-card">
          <div className="th-between">
            <strong>{targetLabel(r)}</strong>
            <span className="th-post-ts" title={new Date(r.ts).toLocaleString()}>
              {new Date(r.ts).toLocaleString()}
            </span>
          </div>
          <p style={{ margin: "8px 0" }}>{r.reason}</p>
          <p className="th-muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            Reported by {r.reporter} · seq {r.seq}
          </p>
          <div className="th-chip-row">
            <button
              type="button"
              className="vs-btn th-btn-sm"
              onClick={() => setExpanded(expanded === r.seq ? null : r.seq)}
            >
              {expanded === r.seq ? "Close" : "Take action"}
            </button>
            <button type="button" className="vs-btn th-btn-sm" onClick={() => onDismiss(r.seq)}>
              Dismiss
            </button>
          </div>
          {expanded === r.seq && (
            <ReportActions report={r} modIdentity={modIdentity} onActed={onActed} />
          )}
        </article>
      ))}
    </div>
  );
}

function ReportActions({
  report,
  modIdentity,
  onActed,
}: {
  report: Report;
  modIdentity: { username: string };
  onActed: () => void;
}) {
  const [target, setTarget] = useState<{ username: string | null; wallet: string | null } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [mode, setMode] = useState<"warn" | "timeout" | "ban" | null>(null);
  const [reason, setReason] = useState("");
  const [durationMin, setDurationMin] = useState(60);
  const [banTemp, setBanTemp] = useState(true);
  const [banHours, setBanHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const resolve = async () => {
    setResolving(true);
    setError(null);
    try {
      const q = new URLSearchParams({ targetKind: report.targetKind });
      if (report.targetSeq !== null && report.targetSeq !== undefined) q.set("targetSeq", String(report.targetSeq));
      if (report.targetId) q.set("targetId", report.targetId);
      if (modIdentity.username) q.set("username", modIdentity.username);
      const d = await authed<{ username: string | null; wallet: string | null }>(
        `/api/townhall/reports/target?${q.toString()}`,
      );
      setTarget(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResolving(false);
    }
  };

  const enforce = async () => {
    if (!target?.wallet || !mode || busy) return;
    const r = reason.trim();
    if (r.length < 10) {
      setError("Reason must be at least 10 characters.");
      return;
    }
    if (r.length > 200) {
      setError("Reason must be at most 200 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const base = { ...modIdentity, wallet: target.wallet, targetUsername: target.username, reason: r };
      if (mode === "warn") {
        await authed(`/api/townhall/moderation/warn`, { method: "POST", body: JSON.stringify(base) });
        setDone(`⚠️ Warned ${target.username ?? target.wallet}.`);
      } else if (mode === "timeout") {
        await authed(`/api/townhall/moderation/timeout`, {
          method: "POST",
          body: JSON.stringify({ ...base, durationMinutes: Math.max(1, Math.floor(durationMin)) }),
        });
        setDone(`⏱️ Timed out ${target.username ?? target.wallet} for ${durationMin} minutes.`);
      } else {
        await authed(`/api/townhall/bans`, {
          method: "POST",
          body: JSON.stringify({
            ...base,
            ...(banTemp ? { expiresAt: Date.now() + Math.max(1, banHours) * 3600_000 } : {}),
          }),
        });
        setDone(`🚫 Banned ${target.username ?? target.wallet}${banTemp ? ` for ${banHours}h` : " permanently"}.`);
      }
      setMode(null);
      onActed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const hideContent = async () => {
    if (busy || (report.targetKind !== "post" && report.targetKind !== "chat")) return;
    if (!window.confirm(`Hide ${targetLabel(report)}? It stays on HCS but is filtered from reads for everyone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await authed(`/api/townhall/mod-actions`, {
        method: "POST",
        body: JSON.stringify({
          ...modIdentity,
          targetKind: report.targetKind,
          targetSeq: report.targetSeq,
        }),
      });
      setDone(`🙈 Hidden ${targetLabel(report)}.`);
      onActed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--vs-border)", paddingTop: 10 }}>
      {!target ? (
        <button type="button" className="vs-btn th-btn-sm" onClick={() => void resolve()} disabled={resolving}>
          {resolving ? "Resolving…" : "🔍 Resolve offender"}
        </button>
      ) : (
        <>
          <p className="th-muted" style={{ margin: "0 0 8px", fontSize: "0.9rem" }}>
            Offender: <strong>{target.username ? `@${target.username}` : "(unknown)"}</strong>
            {target.wallet ? ` · ${target.wallet}` : " · no wallet resolvable"}
          </p>
          {!target.wallet ? (
            <p className="th-error">No wallet resolvable for this offender — enforcement actions are unavailable.</p>
          ) : (
            <>
              <div className="th-chip-row">
                {(["warn", "timeout", "ban"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`vs-btn th-btn-sm${mode === m ? " vs-btn-primary" : ""}`}
                    onClick={() => setMode(mode === m ? null : m)}
                  >
                    {m === "warn" ? "⚠️ Warn" : m === "timeout" ? "⏱️ Timeout" : "🚫 Ban"}
                  </button>
                ))}
                {(report.targetKind === "post" || report.targetKind === "chat") && (
                  <button type="button" className="vs-btn th-btn-sm" onClick={() => void hideContent()} disabled={busy}>
                    🙈 Hide content
                  </button>
                )}
              </div>
              {mode && (
                <div style={{ marginTop: 10 }}>
                  <label className="th-muted" htmlFor="th-mod-reason" style={{ display: "block", marginBottom: 6 }}>
                    Reason (10–200 chars)
                  </label>
                  <textarea
                    id="th-mod-reason"
                    className="vs-input"
                    rows={3}
                    maxLength={200}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why is this action being taken?"
                    style={{ width: "100%", resize: "vertical", marginBottom: 8 }}
                  />
                  {mode === "timeout" && (
                    <label className="th-muted" style={{ display: "block", marginBottom: 8 }}>
                      Duration (minutes, 1–43200):{" "}
                      <input
                        type="number"
                        className="vs-input"
                        min={1}
                        max={43200}
                        value={durationMin}
                        onChange={(e) => setDurationMin(Number(e.target.value))}
                        style={{ width: 100 }}
                      />
                    </label>
                  )}
                  {mode === "ban" && (
                    <div style={{ marginBottom: 8 }}>
                      <label className="th-muted" style={{ marginRight: 12 }}>
                        <input type="checkbox" checked={banTemp} onChange={(e) => setBanTemp(e.target.checked)} />{" "}
                        Temporary
                      </label>
                      {banTemp && (
                        <label className="th-muted">
                          Hours:{" "}
                          <input
                            type="number"
                            className="vs-input"
                            min={1}
                            value={banHours}
                            onChange={(e) => setBanHours(Number(e.target.value))}
                            style={{ width: 80 }}
                          />
                        </label>
                      )}
                    </div>
                  )}
                  <button type="button" className="vs-btn vs-btn-primary th-btn-sm" onClick={() => void enforce()} disabled={busy}>
                    {busy ? "Working…" : `Confirm ${mode}`}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
      {error && <p className="th-error" style={{ marginTop: 8 }}>{error}</p>}
      {done && <p style={{ marginTop: 8 }}>✅ {done}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Warnings                                                            */
/* ------------------------------------------------------------------ */

function WarningsList({ warnings, onLifted }: { warnings: Warn[]; onLifted: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lift = async (wallet: string) => {
    if (!window.confirm(`Lift the warning for ${wallet}? The warning record stays on HCS (auditable) but no longer counts as active.`)) return;
    setBusy(wallet);
    setError(null);
    try {
      await authed(`/api/townhall/bans`, { method: "DELETE", body: JSON.stringify({ wallet }) });
      onLifted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (warnings.length === 0) return <p className="th-muted" style={{ marginTop: 16 }}>No active warnings.</p>;
  return (
    <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
      {error && <p className="th-error">{error}</p>}
      {warnings.map((w) => (
        <article key={w.wallet} className="th-card">
          <div className="th-between">
            <strong>{w.username ? `@${w.username}` : w.wallet}</strong>
            <span className="th-post-ts">{new Date(w.ts).toLocaleString()}</span>
          </div>
          <p style={{ margin: "8px 0" }}>“{w.reason}”</p>
          <p className="th-muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            Warned by {w.warnedBy} · {w.wallet}
          </p>
          <div className="th-chip-row">
            <button type="button" className="vs-btn th-btn-sm" disabled={busy === w.wallet} onClick={() => void lift(w.wallet)}>
              {busy === w.wallet ? "Lifting…" : "Lift warning"}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Timeouts & bans                                                     */
/* ------------------------------------------------------------------ */

function RestrictionsList({
  bans,
  timeouts,
  onLifted,
}: {
  bans: Ban[];
  timeouts: Timeout[];
  onLifted: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lift = async (wallet: string, label: string) => {
    if (!window.confirm(`Lift the ${label} for ${wallet}?`)) return;
    setBusy(wallet);
    setError(null);
    try {
      await authed(`/api/townhall/bans`, { method: "DELETE", body: JSON.stringify({ wallet }) });
      onLifted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const rows: { key: string; kind: string; wallet: string; username: string | null; reason: string; by: string; expiresAt: number | null; ts: string }[] = [
    ...timeouts.map((t) => ({
      key: `t-${t.wallet}`, kind: "⏱️ Timeout", wallet: t.wallet, username: t.username,
      reason: t.reason, by: t.timedOutBy, expiresAt: t.expiresAt as number | null, ts: t.ts,
    })),
    ...bans.map((b) => ({
      key: `b-${b.wallet}`, kind: b.expiresAt ? "🚫 Temp ban" : "🚫 Permanent ban", wallet: b.wallet,
      username: b.username, reason: b.reason, by: b.bannedBy, expiresAt: b.expiresAt, ts: b.ts,
    })),
  ];

  if (rows.length === 0) return <p className="th-muted" style={{ marginTop: 16 }}>No active timeouts or bans.</p>;
  return (
    <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
      {error && <p className="th-error">{error}</p>}
      {rows.map((r) => (
        <article key={r.key} className="th-card">
          <div className="th-between">
            <strong>{r.kind} — {r.username ? `@${r.username}` : r.wallet}</strong>
            <span className="th-post-ts">{new Date(r.ts).toLocaleString()}</span>
          </div>
          <p style={{ margin: "8px 0" }}>“{r.reason}”</p>
          <p className="th-muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            By {r.by} · {r.wallet}
            {r.expiresAt ? ` · lifts ${new Date(r.expiresAt).toLocaleString()}` : " · does not expire"}
          </p>
          <div className="th-chip-row">
            <button type="button" className="vs-btn th-btn-sm" disabled={busy === r.wallet} onClick={() => void lift(r.wallet, r.kind)}>
              {busy === r.wallet ? "Lifting…" : r.kind.includes("Timeout") ? "End timeout" : "Unban"}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Appeals                                                             */
/* ------------------------------------------------------------------ */

function AppealsList({ appeals, onResolved }: { appeals: Appeal[]; onResolved: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const resolve = async (wallet: string, action: "upheld" | "lifted") => {
    const verb = action === "lifted" ? "overturn (lift the restriction)" : "uphold (keep the restriction)";
    if (!window.confirm(`Are you sure you want to ${verb} for ${wallet}?`)) return;
    setBusy(wallet);
    setError(null);
    try {
      await authed(`/api/townhall/appeals/resolve`, {
        method: "POST",
        body: JSON.stringify({ wallet, action, ...(note.trim() ? { note: note.trim().slice(0, 200) } : {}) }),
      });
      setNote("");
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (appeals.length === 0) return <p className="th-muted" style={{ marginTop: 16 }}>No pending appeals.</p>;
  return (
    <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
      {error && <p className="th-error">{error}</p>}
      <label className="th-muted" htmlFor="th-appeal-note" style={{ display: "block" }}>
        Optional moderator note (shown with the resolution, max 200 chars)
      </label>
      <input
        id="th-appeal-note"
        className="vs-input"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={200}
        placeholder="e.g. First offense, user apologized…"
        style={{ width: "100%" }}
      />
      {appeals.map((a) => (
        <article key={a.wallet} className="th-card">
          <div className="th-between">
            <strong>{a.wallet}</strong>
            <span className="th-post-ts">{new Date(a.ts).toLocaleString()}</span>
          </div>
          {a.restriction && (
            <p className="th-muted" style={{ margin: "8px 0 0", fontSize: "0.9rem" }}>
              Current restriction: <strong>{a.restriction.status}</strong>
              {a.restriction.reason ? ` — “${a.restriction.reason}”` : ""}
            </p>
          )}
          <p style={{ margin: "8px 0" }}>
            <strong>Appellant&apos;s statement:</strong> “{a.reason}”
          </p>
          <div className="th-chip-row">
            <button
              type="button"
              className="vs-btn vs-btn-primary th-btn-sm"
              disabled={busy === a.wallet}
              onClick={() => void resolve(a.wallet, "lifted")}
            >
              {busy === a.wallet ? "Working…" : "Overturn (lift)"}
            </button>
            <button
              type="button"
              className="vs-btn th-btn-sm"
              disabled={busy === a.wallet}
              onClick={() => void resolve(a.wallet, "upheld")}
            >
              {busy === a.wallet ? "Working…" : "Uphold"}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
