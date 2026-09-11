"use client";

/**
 * <DustFeeGate> — renders the "pay tiny fee" step of the dust-fee flow.
 *
 * Pair with useDustFee(): the caller runs dust.execute(attempt) on submit,
 * and this component shows the fee prompt when the server answers 402,
 * then retries automatically once the wallet pays the fee.
 */
import type { DustFeeFlow } from "./useTownhall";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { HbarAmount } from "@/components/HbarAmount";

export default function DustFeeGate({
  flow,
  actionLabel = "post",
}: {
  flow: DustFeeFlow;
  actionLabel?: string;
}) {
  const { phase, payFee, reset } = flow;
  const { t } = useLanguage();

  if (phase.kind === "idle" || phase.kind === "working") return null;

  if (phase.kind === "paying") {
    return (
      <div className="th-dust" role="status" aria-live="polite">
        <div className="th-dust-title">{t("dust.paying")}</div>
        <p>{t("dust.payingBody")}</p>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="th-dust is-error" role="alert">
        <div className="th-dust-title">{t("dust.errorTitle")}</div>
        <p>{phase.message}</p>
        <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={reset}>
          {t("dust.dismiss")}
        </button>
      </div>
    );
  }

  // phase.kind === "fee"
  const hbar = (phase.tinybars / 100_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return (
    <div className="th-dust" role="dialog" aria-label="Dust fee required">
      <div className="th-dust-title">{t("dust.title")}</div>
      <p>
        {t("dust.bodyA")} <strong><HbarAmount hbar={hbar} /></strong> {t("dust.bodyB")}
      </p>
      <p className="vs-mono th-dust-treasury" title={phase.treasury}>
        → {phase.treasury.slice(0, 10)}…{phase.treasury.slice(-6)}
      </p>
      <div className="th-row">
        <button type="button" className="vs-btn vs-btn-primary th-btn-sm" onClick={payFee}>
          {t("dust.pay")} <HbarAmount hbar={hbar} /> &amp; {actionLabel}
        </button>
        <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={reset}>
          {t("dust.cancel")}
        </button>
      </div>
    </div>
  );
}
