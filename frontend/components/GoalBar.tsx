"use client";

/**
 * <GoalBar> — public funding-goal progress for a blockpage.
 *
 * Renders nothing when the page owner has not set a goal. When set, shows
 * the goal title, a progress bar, and the honest funding rule: progress
 * counts every tip ever sent on-chain to this page — the creator's 98%
 * share recorded by the Tips contract. Goals move no funds; tipping stays
 * direct wallet-to-wallet on-chain.
 */
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { HbarAmount } from "@/components/HbarAmount";
import { useFundingGoal } from "@/hooks/useFundingGoal";

export function GoalBar({
  username,
  ownerAddress,
}: {
  username: string;
  ownerAddress: string;
}) {
  const { t } = useLanguage();
  const { goal, raised, reached } = useFundingGoal(username, ownerAddress);

  if (!goal) return null;

  const target = goal.targetHbar;
  const raisedHbar = raised ?? 0;
  const pct = target > 0 ? Math.max(0, Math.min(100, (raisedHbar / target) * 100)) : 0;

  return (
    <section
      aria-label={t("goal.title")}
      style={{
        margin: "18px 0",
        padding: 16,
        borderRadius: 14,
        border: "1px solid var(--vs-border, rgba(255,255,255,0.12))",
        background: "var(--vs-card, rgba(255,255,255,0.03))",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: "1rem", margin: 0 }}>
          🎯 {goal.title ? goal.title : t("goal.title")}
        </h2>
        {reached && (
          <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--vs-accent, #34d399)" }}>
            {t("goal.reached")}
          </span>
        )}
      </div>
      <p className="th-muted" style={{ fontSize: "0.82rem", margin: "4px 0 10px" }}>
        {t("goal.tipToHelp")}
      </p>
      <div
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t("goal.title")}
        style={{
          height: 10,
          borderRadius: 6,
          background: "var(--vs-track, rgba(255,255,255,0.1))",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 6,
            background: "linear-gradient(90deg, var(--vs-accent, #34d399), var(--vs-accent2, #22d3ee))",
            transition: "width 0.6s ease",
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 8, fontSize: "0.85rem" }}>
        <span className="vs-mono">
          {t("goal.progress").replace("{raised}", raisedHbar.toFixed(4)).replace("{target}", target.toFixed(4))}
        </span>
        <span className="th-muted">{Math.round(pct)}%</span>
      </div>
      <p className="th-muted" style={{ fontSize: "0.75rem", margin: "8px 0 0", lineHeight: 1.5 }}>
        {t("goal.rule")}
      </p>
      <div style={{ marginTop: 6, fontSize: "0.8rem", opacity: 0.8 }}>
        <HbarAmount hbar={raisedHbar.toFixed(4)} />
      </div>
    </section>
  );
}
