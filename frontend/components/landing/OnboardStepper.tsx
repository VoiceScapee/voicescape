"use client";

/**
 * Brand pass PORT-O — "Crypto, explained like a human", the onboarding
 * stepper ported 1:1 from the approved brand-pass mock (screen 2).
 *
 * The journey states are the illustrative design Brandon approved —
 * step 1 shown done, step 2 active, steps 3–4 upcoming — not dynamic
 * progress. All copy comes from the i18n dictionaries (onboard.* keys).
 */
import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import type { I18nKey } from "@/lib/i18n/dictionaries";

type StepState = "done" | "active" | "upcoming";

const STEPS: { titleKey: I18nKey; bodyKey: I18nKey; state: StepState }[] = [
  { titleKey: "onboard.s1t", bodyKey: "onboard.s1b", state: "done" },
  { titleKey: "onboard.s2t", bodyKey: "onboard.s2b", state: "active" },
  { titleKey: "onboard.s3t", bodyKey: "onboard.s3b", state: "upcoming" },
  { titleKey: "onboard.s4t", bodyKey: "onboard.s4b", state: "upcoming" },
];

const DISPLAY_FONT = 'var(--font-display, "Montserrat"), var(--vs-font)';

export function OnboardStepper() {
  const { t } = useLanguage();
  const router = useRouter();

  return (
    <section style={{ maxWidth: 640, margin: "0 auto", padding: "12px 4px 44px" }}>
      <span className="vs-eyebrow">{t("onboard.eyebrow")}</span>
      <h2
        style={{
          fontFamily: DISPLAY_FONT,
          fontWeight: 700,
          letterSpacing: "-0.03em",
          lineHeight: 1.05,
          fontSize: "clamp(26px, 5.6vw, 36px)",
          margin: "14px 0 8px",
        }}
      >
        {t("onboard.title")}
      </h2>
      <p style={{ color: "var(--vs-muted)", fontSize: 15.5, lineHeight: 1.6, margin: "0 0 28px" }}>
        {t("onboard.lede")}
      </p>

      <div>
        {STEPS.map((s, i) => {
          const numStateStyle: CSSProperties =
            s.state === "done"
              ? {
                  background: "rgba(130,89,239,.15)",
                  borderColor: "rgba(130,89,239,.5)",
                  color: "#cfc2ff",
                }
              : s.state === "active"
                ? {
                    background: "var(--vs-gradient)",
                    border: "0",
                    color: "#fff",
                    boxShadow: "0 0 22px rgba(130,89,239,.5)",
                  }
                : {};
          return (
            <div
              key={s.titleKey}
              style={{
                display: "flex",
                gap: 16,
                padding: "18px 0",
                borderBottom: i < STEPS.length - 1 ? "1px solid var(--vs-border)" : "0",
              }}
            >
              <div
                aria-hidden
                style={{
                  flex: "0 0 34px",
                  height: 34,
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: "var(--vs-mono)",
                  fontSize: 14,
                  fontWeight: 700,
                  background: "#141926",
                  border: "1px solid var(--vs-border)",
                  color: "var(--vs-muted)",
                  ...numStateStyle,
                }}
              >
                {s.state === "done" ? "✓" : i + 1}
              </div>
              <div>
                <h3
                  style={{
                    margin: "2px 0 6px",
                    fontSize: 16.5,
                    letterSpacing: "-0.01em",
                    color: s.state === "active" ? "#fff" : undefined,
                  }}
                >
                  {t(s.titleKey)}
                </h3>
                <p
                  style={{
                    margin: 0,
                    color: s.state === "active" ? "#d6d9e2" : "var(--vs-muted)",
                    fontSize: 14.5,
                    lineHeight: 1.6,
                  }}
                >
                  {t(s.bodyKey)}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 28 }}>
        <button type="button" className="vs-btn vs-btn-ghost" onClick={() => router.back()}>
          {t("onboard.back")}
        </button>
        <button
          type="button"
          className="vs-btn vs-btn-primary"
          style={{ flex: 1 }}
          onClick={() => router.push("/builder")}
        >
          {t("onboard.keepGoing")}
        </button>
      </div>
    </section>
  );
}
