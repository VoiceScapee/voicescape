/**
 * "New to Web3? Start here" — its own page, linked from the navbar.
 *
 * The plain-language dApp explainer (what a dApp is, wallet-as-login, why
 * Hedera fees are pennies), the on-chain tipping / 2% fee strip, plus the
 * "How it works" getting-started steps live here only — not on the landing
 * page.
 */
import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import Logo from "@/components/Logo";
import BuiltOnHedera from "@/components/BuiltOnHedera";
import { WalletConnect } from "@/components/WalletConnect";
import { T } from "@/components/T";
import { NewToWeb3 } from "@/components/landing/NewToWeb3";
import { FeeStrip } from "@/components/landing/FeeStrip";
import { IconCheck } from "@/components/icons";
import type { I18nKey } from "@/lib/i18n/dictionaries";

export const metadata: Metadata = {
  title: "New to Web3? Start here — Voicescape",
  description:
    "Crypto explained like a human: what a dApp is, why your wallet is your login, and why Hedera keeps fees at pennies, not dollars.",
};

const STEPS: { titleKey: I18nKey; bodyKey: I18nKey }[] = [
  { titleKey: "landing.step1t", bodyKey: "landing.step1b" },
  { titleKey: "landing.step2t", bodyKey: "landing.step2b" },
  { titleKey: "landing.step3t", bodyKey: "landing.step3b" },
  { titleKey: "landing.step4t", bodyKey: "landing.step4b" },
];

export default function NewToWeb3Page() {
  return (
    <main style={{ minHeight: "100vh", background: "var(--vs-bg)" }}>
      <Navbar right={<WalletConnect />} />
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 18px 72px" }}>
        <NewToWeb3 />

        {/* On-chain tipping / 2% fee explainer — lives here only, not on the landing */}
        <FeeStrip />

        {/* How it works — the 4-step value prop (lives here only) */}
        <section className="vs-section" style={{ paddingTop: 0 }}>
          <p className="vs-label" style={{ textAlign: "center" }}><T k="landing.gettingStarted" /></p>
          <h2 style={{ fontSize: "clamp(1.6rem, 4.5vw, 2.4rem)", margin: "12px 0 32px", textAlign: "center" }}>
            <T k="landing.howItWorks" />
          </h2>
          <div className="vs-grid-2">
            {STEPS.map((s, i) => (
              <div key={s.titleKey} className="vs-glass" style={{ padding: 24, display: "flex", gap: 16 }}>
                <div
                  className="vs-mono"
                  style={{
                    flexShrink: 0,
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 16,
                    fontWeight: 700,
                    background: "var(--vs-gradient)",
                    color: "#fff",
                  }}
                >
                  {i + 1}
                </div>
                <div>
                  <h3 style={{ margin: "0 0 6px", fontSize: 17, display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "var(--vs-cyan)", display: "inline-flex" }}><IconCheck size={16} /></span>
                    <T k={s.titleKey} />
                  </h3>
                  <p style={{ margin: 0, color: "var(--vs-muted)", lineHeight: 1.7, fontSize: 15 }}><T k={s.bodyKey} /></p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Footer */}
        <footer
          style={{
            borderTop: "1px solid var(--vs-border)",
            padding: "32px 24px",
            textAlign: "center",
            color: "var(--vs-muted)",
            fontSize: 13,
          }}
        >
          <div style={{ marginBottom: 12 }}>
            <Logo size={24} />
          </div>
          <p className="vs-mono" style={{ margin: 0 }}>
            <T k="landing.footerTagline" />
          </p>
          <BuiltOnHedera />
        </footer>
      </div>
    </main>
  );
}
