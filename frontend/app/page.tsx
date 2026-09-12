import Link from "next/link";
import Splash from "@/components/Splash";
import Navbar from "@/components/Navbar";
import Logo from "@/components/Logo";
import { T } from "@/components/T";
import { WalletConnect } from "@/components/WalletConnect";
import { OnboardingTrigger } from "@/components/OnboardingTrigger";
import {
  IconArrowRight,
  IconCheck,
  IconGrid,
  IconLink,
  IconSpark,
  IconTip,
} from "@/components/icons";
import type { I18nKey } from "@/lib/i18n/dictionaries";

const FEATURES: { icon: typeof IconGrid; titleKey: I18nKey; bodyKey: I18nKey }[] = [
  { icon: IconGrid, titleKey: "landing.f1t", bodyKey: "landing.f1b" },
  { icon: IconSpark, titleKey: "landing.f2t", bodyKey: "landing.f2b" },
  { icon: IconLink, titleKey: "landing.f3t", bodyKey: "landing.f3b" },
  { icon: IconTip, titleKey: "landing.f4t", bodyKey: "landing.f4b" },
];

const STEPS: { titleKey: I18nKey; bodyKey: I18nKey }[] = [
  { titleKey: "landing.step1t", bodyKey: "landing.step1b" },
  { titleKey: "landing.step2t", bodyKey: "landing.step2b" },
  { titleKey: "landing.step3t", bodyKey: "landing.step3b" },
  { titleKey: "landing.step4t", bodyKey: "landing.step4b" },
];

export default function LandingPage() {
  return (
    <>
      <Splash />
      <OnboardingTrigger />
      <main id="enter">
        <Navbar
          right={
            <WalletConnect />
          }
        />

        {/* What is Voicescape */}
        <section className="vs-section" style={{ textAlign: "center" }}>
          <p className="vs-label"><T k="landing.whatIs" /></p>
          <h2 style={{ fontSize: "clamp(1.6rem, 4.5vw, 2.4rem)", margin: "12px 0 20px" }}>
            <T k="landing.hero1" /> <span className="vs-gradient-text"><T k="landing.hero2" /></span>
          </h2>
          <p style={{ lineHeight: 1.8, color: "var(--vs-muted)", maxWidth: 680, margin: "0 auto", fontSize: 17 }}>
            <T k="landing.heroBody" />
          </p>
          <div style={{ marginTop: 28, display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <Link
              href="/builder"
              className="vs-btn vs-btn-primary"
              style={{ padding: "14px 32px", fontSize: 16, textDecoration: "none" }}
            >
              <T k="landing.openBuilder" />
              <IconArrowRight size={18} />
            </Link>
            <Link
              href="/explore"
              className="vs-btn vs-btn-ghost"
              style={{ padding: "14px 32px", fontSize: 16, textDecoration: "none" }}
            >
              Explore Blockpages
            </Link>
          </div>
        </section>

        {/* How it works — the 4-step value prop, right up top */}
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
                    background: "linear-gradient(135deg, var(--vs-violet), var(--vs-cyan))",
                    color: "#06060e",
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

        {/* Features */}
        <section className="vs-section" style={{ paddingTop: 0 }}>
          <div className="vs-grid-2">
            {FEATURES.map((f) => (
              <div key={f.titleKey} className="vs-card" style={{ display: "flex", gap: 18 }}>
                <div
                  style={{
                    flexShrink: 0,
                    width: 48,
                    height: 48,
                    borderRadius: 12,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "linear-gradient(135deg, rgba(16,185,129,0.25), rgba(52,211,153,0.18))",
                    border: "1px solid var(--vs-border)",
                    color: "var(--vs-cyan)",
                  }}
                >
                  <f.icon size={24} />
                </div>
                <div>
                  <h3 style={{ margin: "0 0 8px", fontSize: 18 }}><T k={f.titleKey} /></h3>
                  <p style={{ margin: 0, lineHeight: 1.7, color: "var(--vs-muted)", fontSize: 15 }}>
                    <T k={f.bodyKey} />
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 2% fee — compact strip */}
        <section style={{ background: "var(--vs-bg2)", borderTop: "1px solid var(--vs-border)", borderBottom: "1px solid var(--vs-border)" }}>
          <div className="vs-section" style={{ textAlign: "center", paddingTop: 40, paddingBottom: 40 }}>
            <p className="vs-label"><T k="landing.feeLabel" /></p>
            <p style={{ fontSize: "clamp(1.2rem, 3.5vw, 1.6rem)", fontWeight: 700, margin: "12px 0 8px" }}>
              <T k="landing.feeTitle1" /> <span className="vs-gradient-text"><T k="landing.feeTitle2" /></span> <T k="landing.feeTitle3" />
            </p>
            <p style={{ lineHeight: 1.7, color: "var(--vs-muted)", fontSize: 15, margin: 0, maxWidth: 640, marginLeft: "auto", marginRight: "auto" }}>
              <T k="landing.feeNote" />
            </p>
          </div>
        </section>

        {/* Closing CTA */}
        <section
          className="vs-section"
          style={{
            textAlign: "center",
          }}
        >
          <h2
            style={{
              fontSize: "clamp(1.6rem, 4.5vw, 2.4rem)",
              margin: "0 0 12px",
            }}
          >
            <span className="vs-gradient-text"><T k="splash.tagline" /></span>
          </h2>
          <p style={{ color: "var(--vs-muted)", fontSize: 16, margin: "0 0 28px" }}>
            <T k="splash.sub" />
          </p>
          <Link href="/builder" className="vs-btn vs-btn-primary" style={{ fontSize: 18, padding: "15px 36px" }}>
            <T k="landing.openBuilder" />
            <IconArrowRight size={20} />
          </Link>
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
        </footer>
      </main>
    </>
  );
}
