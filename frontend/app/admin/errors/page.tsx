"use client";

/**
 * Founder-only client error dashboard — /admin/errors.
 *
 * Shows aggregate client error reports from the last 7 days: message,
 * page, component, first stack frame, count, first/last seen.
 * Aggregates contain no PII by
 * construction (no IPs, user agents, wallet addresses, query strings,
 * or full stack traces are ever stored — only a single scrubbed first
 * frame).
 *
 * Access is gated server-side: GET /api/admin/errors requires a valid
 * wallet session from a founder wallet.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/session";
import { useWriteGate } from "@/components/townhall/useTownhall";
import { WalletConnect } from "@/components/WalletConnect";

interface ErrorAggregate {
  page: string;
  message: string;
  component: string | null;
  frame: string | null;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

interface MetricsDay {
  date: string;
  events: Record<string, number>;
}

export default function AdminErrorsPage() {
  const { isAuthenticated, sessionReady } = useWriteGate();
  let session: ReturnType<typeof useSession> | null = null;
  try {
    session = useSession();
  } catch {
    session = null;
  }
  const [errors, setErrors] = useState<ErrorAggregate[] | null>(null);
  const [metrics, setMetrics] = useState<MetricsDay[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionReady || !isAuthenticated || !session) return;
    let live = true;
    setLoading(true);
    setError(null);
    const headers = { ...session.authHeader() };
    // Conversion aggregates (founder-only). Best-effort: a metrics failure
    // must not hide the error reports.
    fetch("/api/admin/metrics", { headers })
      .then(async (res) => {
        if (!live || !res.ok) return;
        const body = (await res.json().catch(() => ({}))) as { days?: MetricsDay[] };
        if (live && Array.isArray(body.days)) setMetrics(body.days);
      })
      .catch(() => {
        /* metrics are supplementary — error reports are the priority */
      });
    fetch("/api/admin/errors", { headers: { ...session.authHeader() } })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!live) return;
        if (!res.ok) {
          setError(
            res.status === 403
              ? "Founders only — this wallet isn't on the founder list."
              : typeof body.error === "string"
                ? body.error
                : `Request failed (${res.status})`,
          );
          setErrors(null);
        } else {
          setErrors(Array.isArray(body.errors) ? (body.errors as ErrorAggregate[]) : []);
        }
      })
      .catch(() => {
        if (live) {
          setError("Could not load error reports — check your connection and retry.");
          setErrors(null);
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [sessionReady, isAuthenticated, session]);

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "24px 18px 72px" }}>
      <Link href="/" className="th-muted" style={{ fontSize: 13 }}>
        ← Home
      </Link>
      <h1 style={{ margin: "12px 0 4px" }}>🛠 Error reports</h1>
      <p className="th-muted" style={{ fontSize: 13, marginTop: 0 }}>
        Aggregate client errors from the last 7 days. Anonymous by design — no IPs, user agents,
        wallets, or query strings are stored.
      </p>

      {!sessionReady ? (
        <p className="th-muted">Loading…</p>
      ) : !isAuthenticated ? (
        <div className="vs-card" style={{ padding: 20, textAlign: "center" }}>
          <p className="th-muted" style={{ marginBottom: 16 }}>
            Sign in with your wallet to view error reports.
          </p>
          <WalletConnect />
        </div>
      ) : loading ? (
        <p className="th-muted">Loading reports…</p>
      ) : error ? (
        <div className="vs-card" style={{ padding: 16, borderColor: "#7f1d1d" }}>
          <p style={{ color: "#fca5a5", margin: 0 }}>{error}</p>
        </div>
      ) : !errors || errors.length === 0 ? (
        <div className="vs-card" style={{ padding: 16 }}>
          <p className="th-muted" style={{ margin: 0 }}>
            No client errors reported in the last 7 days. 🎉
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {errors.map((e, i) => (
            <div key={i} className="vs-card" style={{ padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                <code
                  style={{
                    fontSize: 13,
                    wordBreak: "break-word",
                    color: "#fca5a5",
                  }}
                >
                  {e.message}
                </code>
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: 12,
                    fontWeight: 700,
                    background: "#7f1d1d",
                    color: "#fecaca",
                    borderRadius: 999,
                    padding: "2px 10px",
                  }}
                >
                  ×{e.count}
                </span>
              </div>
              <div className="th-muted" style={{ fontSize: 12, marginTop: 8 }}>
                <span>
                  Page: <code>{e.page}</code>
                </span>
                {e.component && (
                  <span style={{ marginLeft: 12 }}>
                    Component: <code>{e.component}</code>
                  </span>
                )}
                {e.frame && (
                  <span style={{ marginLeft: 12 }}>
                    First frame: <code>{e.frame}</code>
                  </span>
                )}
              </div>
              <div className="th-muted" style={{ fontSize: 12, marginTop: 4 }}>
                First: {fmtTime(e.firstSeen)} · Last: {fmtTime(e.lastSeen)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Founder-only aggregate conversion funnel (last 7 days). */}
      {metrics && metrics.some((d) => Object.keys(d.events).length > 0) && (
        <div style={{ marginTop: 32 }}>
          <h2 style={{ margin: "0 0 4px" }}>📊 Conversion</h2>
          <p className="th-muted" style={{ fontSize: 13, marginTop: 0 }}>
            Aggregate paid-action funnel, last 7 days. Anonymous by design — counts only, no wallets or sessions.
          </p>
          <FunnelSummary days={metrics} />
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {metrics.map((d) => {
              const names = Object.keys(d.events);
              if (names.length === 0) return null;
              return (
                <div key={d.date} className="vs-card" style={{ padding: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{d.date}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {names.sort().map((name) => (
                      <span
                        key={name}
                        style={{
                          fontSize: 12,
                          background: "rgba(255,255,255,0.06)",
                          borderRadius: 999,
                          padding: "2px 10px",
                        }}
                      >
                        <code>{name}</code> ×{d.events[name]}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** 7-day funnel totals with attempt → confirmed rates for paid actions. */
function FunnelSummary({ days }: { days: MetricsDay[] }) {
  const total = (name: string) => days.reduce((n, d) => n + (d.events[name] ?? 0), 0);
  const rows: { label: string; attempts: number; confirmed: number }[] = [
    { label: "Tips", attempts: total("tip_attempt"), confirmed: total("tip_confirmed") },
    { label: "Purchases", attempts: total("purchase_attempt"), confirmed: total("purchase_confirmed") },
    { label: "Votes", attempts: total("vote_submitted") + total("vote_failed"), confirmed: total("vote_submitted") },
    { label: "Proposals", attempts: total("proposal_submitted") + total("proposal_failed"), confirmed: total("proposal_submitted") },
    { label: "Chat", attempts: total("chat_sent") + total("chat_failed"), confirmed: total("chat_sent") },
  ];
  return (
    <div className="vs-card" style={{ padding: 12 }}>
      {rows.map((r) => {
        const rate = r.attempts > 0 ? Math.round((r.confirmed / r.attempts) * 100) : null;
        return (
          <div key={r.label} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
            <span>{r.label}</span>
            <span className="th-muted">
              {r.confirmed}/{r.attempts}{rate !== null ? ` · ${rate}%` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
