"use client";

/**
 * <EarningsPanel> — private creator earnings view for the blockpage owner.
 *
 * Only rendered inside the blockpage's `isOwner` branch. Shows:
 *  - tips received (7d / 30d / all-time) from the on-chain Tips contract
 *    via GET /api/earnings (official Hedera Mirror Node, read-only),
 *  - unique tippers (30d),
 *  - page visits (7d / 30d) via GET /api/analytics/stats (owner-only,
 *    wallet session in x-vs-session), labeled (approx) with the honest
 *    methodology note,
 *  - the funding-goal setter (target HBAR + optional title), public goal
 *    shown below in <GoalBar> once set.
 */
import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useSession } from "@/lib/session";
import { HbarAmount } from "@/components/HbarAmount";
import { getHbarUsdPrice } from "@/lib/x402";
import TaxNotice from "@/components/TaxNotice";

interface EarningsData {
  hbar7d: string;
  hbar30d: string;
  hbarAllTime: string;
  tipCount7d: number;
  tipCount30d: number;
  uniqueTippers30d: number;
  error?: string;
}

interface StatsData {
  viewsLast7d: number;
  viewsLast30d: number;
  error?: string;
}

function fmtHbar(s: string | undefined): string {
  const n = Number(s);
  return Number.isFinite(n) ? n.toFixed(4) : "0.0000";
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: 12,
        border: "1px solid var(--vs-border, rgba(255,255,255,0.12))",
        background: "var(--vs-card, rgba(255,255,255,0.03))",
        minWidth: 0,
      }}
    >
      <div className="th-muted" style={{ fontSize: "0.75rem", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: "1.15rem", fontWeight: 700, overflowWrap: "anywhere" }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: "0.75rem", marginTop: 2, opacity: 0.85 }}>{sub}</div>
      )}
    </div>
  );
}

export function EarningsPanel({
  username,
  ownerAddress,
  ownerType,
}: {
  username: string;
  ownerAddress: string;
  ownerType: "human" | "agent";
}) {
  const { t } = useLanguage();
  const { authHeader } = useSession();
  const [earnings, setEarnings] = useState<EarningsData | null>(null);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  // Funding-goal form state.
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState("");
  const [goalBusy, setGoalBusy] = useState(false);
  const [goalMsg, setGoalMsg] = useState<string | null>(null);
  const [hasGoal, setHasGoal] = useState(false);
  // Live HBAR price for the USD hint under the goal target input.
  const [hbarPrice, setHbarPrice] = useState<number | null>(null);
  useEffect(() => {
    getHbarUsdPrice().then(setHbarPrice).catch(() => setHbarPrice(null));
  }, []);
  const targetNum = Number(target.replace(/,/g, ""));
  const targetUsd =
    target.trim() !== "" && Number.isFinite(targetNum) && targetNum > 0 && hbarPrice
      ? targetNum * hbarPrice
      : null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [eRes, sRes] = await Promise.all([
        fetch(`/api/earnings?address=${encodeURIComponent(ownerAddress)}`),
        fetch(`/api/analytics/stats?username=${encodeURIComponent(username)}`, {
          headers: { ...authHeader() },
        }),
      ]);
      const eJson = (await eRes.json()) as EarningsData;
      const sJson = (await sRes.json()) as StatsData & { error?: string };
      setEarnings(eRes.ok ? eJson : { ...eJson, error: eJson.error ?? t("earnings.unavailable") });
      setStats(sRes.ok ? { viewsLast7d: sJson.viewsLast7d ?? 0, viewsLast30d: sJson.viewsLast30d ?? 0 } : null);
      const gRes = await fetch(`/api/goals?username=${encodeURIComponent(username)}`, { cache: "no-store" });
      const gJson = (await gRes.json()) as { goal?: { targetHbar: number; title: string | null } | null };
      if (gJson.goal) {
        setHasGoal(true);
        setTarget(String(gJson.goal.targetHbar));
        setTitle(gJson.goal.title ?? "");
      }
    } catch {
      setEarnings((e) => e ?? { hbar7d: "0", hbar30d: "0", hbarAllTime: "0", tipCount7d: 0, tipCount30d: 0, uniqueTippers30d: 0, error: t("earnings.unavailable") });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, ownerAddress]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveGoal = async () => {
    setGoalMsg(null);
    const n = Number(target.replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) {
      setGoalMsg(t("goal.invalidTarget"));
      return;
    }
    setGoalBusy(true);
    try {
      const res = await fetch("/api/goals", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader() },
        body: JSON.stringify({ username, targetHbar: n, title: title.trim() || undefined }),
      });
      const json = (await res.json()) as { error?: string; goal?: unknown };
      if (!res.ok) {
        setGoalMsg(json.error ?? t("goal.error"));
      } else {
        setHasGoal(true);
        setGoalMsg(t("goal.saved"));
      }
    } catch {
      setGoalMsg(t("goal.error"));
    } finally {
      setGoalBusy(false);
    }
  };

  const clearGoal = async () => {
    setGoalMsg(null);
    setGoalBusy(true);
    try {
      const res = await fetch(`/api/goals?username=${encodeURIComponent(username)}`, {
        method: "DELETE",
        headers: { ...authHeader() },
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        setGoalMsg(json.error ?? t("goal.error"));
      } else {
        setHasGoal(false);
        setTarget("");
        setTitle("");
        setGoalMsg(t("goal.cleared"));
      }
    } catch {
      setGoalMsg(t("goal.error"));
    } finally {
      setGoalBusy(false);
    }
  };

  return (
    <section
      aria-label={t("earnings.title")}
      style={{
        margin: "18px 0",
        padding: 16,
        borderRadius: 14,
        border: "1px solid var(--vs-border, rgba(255,255,255,0.12))",
        background: "var(--vs-card, rgba(255,255,255,0.03))",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <h2 style={{ fontSize: "1rem", margin: 0 }}>💰 {t("earnings.title")}</h2>
        <span
          className="th-muted"
          style={{
            fontSize: "0.7rem",
            padding: "2px 8px",
            borderRadius: 999,
            border: "1px solid var(--vs-border, rgba(255,255,255,0.12))",
          }}
        >
          {ownerType === "agent" ? `🤖 ${t("earnings.agentPage")}` : `🧑 ${t("earnings.humanPage")}`}
        </span>
      </div>
      <p className="th-muted" style={{ fontSize: "0.8rem", margin: "0 0 12px" }}>
        🔒 {t("earnings.private")}
      </p>

      {loading ? (
        <p className="th-muted" aria-live="polite">{t("earnings.loading")}</p>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: 10,
            }}
          >
            <StatCard
              label={t("earnings.tips7d")}
              value={<HbarAmount hbar={fmtHbar(earnings?.hbar7d)} />}
              sub={(earnings?.tipCount7d === 1 ? t("leaderboard.tipCountSingular") : t("leaderboard.tipCountPlural")).replace("{n}", String(earnings?.tipCount7d ?? 0))}
            />
            <StatCard
              label={t("earnings.tips30d")}
              value={<HbarAmount hbar={fmtHbar(earnings?.hbar30d)} />}
              sub={(earnings?.tipCount30d === 1 ? t("leaderboard.tipCountSingular") : t("leaderboard.tipCountPlural")).replace("{n}", String(earnings?.tipCount30d ?? 0))}
            />
            <StatCard label={t("earnings.tippers30d")} value={earnings?.uniqueTippers30d ?? 0} />
            <StatCard
              label={`${t("earnings.visits7d")} ${t("earnings.approx")}`}
              value={stats ? stats.viewsLast7d : "—"}
            />
            <StatCard
              label={`${t("earnings.visits30d")} ${t("earnings.approx")}`}
              value={stats ? stats.viewsLast30d : "—"}
            />
            <StatCard label={t("earnings.allTime")} value={<HbarAmount hbar={fmtHbar(earnings?.hbarAllTime)} />} />
          </div>
          <TaxNotice compact />
          {earnings?.error && (
            <p style={{ fontSize: "0.8rem", color: "var(--vs-danger, #f87171)", margin: "10px 0 0" }} role="alert">
              {earnings.error}
            </p>
          )}
          <p className="th-muted" style={{ fontSize: "0.75rem", margin: "10px 0 0", lineHeight: 1.5 }}>
            {t("earnings.visitsNote")}
          </p>

          <div
            id="set-funding-goal"
            style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--vs-border, rgba(255,255,255,0.08))", scrollMarginTop: 90 }}
          >
            <h3 style={{ fontSize: "0.95rem", margin: "0 0 10px" }}>🎯 {t("goal.setTitle")}</h3>
            <div style={{ display: "grid", gap: 10, maxWidth: 420 }}>
              <label style={{ display: "grid", gap: 4, fontSize: "0.8rem" }}>
                <span className="th-muted">{t("goal.targetLabel")}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={target}
                  onChange={(e) => setTarget(e.target.value.replace(/[^0-9.,]/g, ""))}
                  placeholder="100"
                  aria-label={t("goal.targetLabel")}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid var(--vs-border, rgba(255,255,255,0.15))",
                    background: "var(--vs-input, rgba(255,255,255,0.05))",
                    color: "inherit",
                    fontSize: "1rem",
                  }}
                />
                {targetUsd !== null && (
                  <span className="th-muted" style={{ fontSize: "0.75rem" }}>
                    ≈ ${targetUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </span>
                )}
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: "0.8rem" }}>
                <span className="th-muted">{t("goal.nameLabel")}</span>
                <input
                  type="text"
                  value={title}
                  maxLength={80}
                  onChange={(e) => setTitle(e.target.value)}
                  aria-label={t("goal.nameLabel")}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid var(--vs-border, rgba(255,255,255,0.15))",
                    background: "var(--vs-input, rgba(255,255,255,0.05))",
                    color: "inherit",
                    fontSize: "1rem",
                  }}
                />
              </label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="pv-tip-btn"
                  onClick={saveGoal}
                  disabled={goalBusy}
                  style={{ padding: "10px 18px", fontSize: "0.9rem" }}
                >
                  {goalBusy ? t("goal.saving") : t("goal.save")}
                </button>
                {hasGoal && (
                  <button
                    type="button"
                    className="vs-btn vs-btn-ghost"
                    onClick={clearGoal}
                    disabled={goalBusy}
                    style={{ padding: "10px 18px", fontSize: "0.9rem" }}
                  >
                    {t("goal.clear")}
                  </button>
                )}
              </div>
              {goalMsg && (
                <p className="th-muted" style={{ fontSize: "0.8rem", margin: 0 }} role="status">
                  {goalMsg}
                </p>
              )}
              {hasGoal &&
                (() => {
                  const raised = Number(earnings?.hbarAllTime);
                  const goalTarget = Number(target.replace(/,/g, ""));
                  return (
                    Number.isFinite(raised) &&
                    Number.isFinite(goalTarget) &&
                    goalTarget > 0 &&
                    raised >= goalTarget && (
                      <p style={{ fontSize: "0.8rem", margin: 0, color: "var(--vs-accent, #34d399)" }} role="status">
                        {t("goal.ownerPausedNote")}
                      </p>
                    )
                  );
                })()}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
