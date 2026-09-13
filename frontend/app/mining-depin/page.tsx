/**
 * "Mining & DePIN" — the experienced corner, linked from the navbar.
 *
 * Companion to /new-to-web3: instead of beginner explainers, this page
 * showcases a curated, verified list of crypto mining and DePIN projects.
 * Every listing was checked live — real projects, real links, no hype.
 */
import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import Logo from "@/components/Logo";
import BuiltOnHedera from "@/components/BuiltOnHedera";
import { WalletConnect } from "@/components/WalletConnect";
import { T } from "@/components/T";
import { MiningDePinCards } from "@/components/landing/MiningDePinCards";
import { MINING_DEPIN_PROJECTS } from "@/lib/landing/mining-depin";

export const metadata: Metadata = {
  title: "Mining & DePIN — Voicescape",
  description:
    "The experienced corner: trusted, verified crypto mining and DePIN projects. Every listing checked live — real projects, real links, no hype.",
};

export default function MiningDePinPage() {
  const showReferralNote = MINING_DEPIN_PROJECTS.some((p) => p.referralUrl);
  return (
    <main style={{ minHeight: "100vh", background: "var(--vs-bg)" }}>
      <Navbar right={<WalletConnect />} />
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 18px 72px" }}>
        {/* Hero */}
        <section className="vs-section" style={{ paddingTop: 0 }}>
          <p className="vs-label" style={{ textAlign: "center" }}>⛏️</p>
          <h1
            style={{
              fontSize: "clamp(1.8rem, 5vw, 2.8rem)",
              margin: "12px 0 12px",
              textAlign: "center",
            }}
          >
            <T k="mining.title" />
          </h1>
          <p
            style={{
              textAlign: "center",
              color: "var(--vs-muted)",
              fontSize: 16,
              maxWidth: 680,
              margin: "0 auto 12px",
              lineHeight: 1.7,
            }}
          >
            <T k="mining.subtitle" />
          </p>
          {showReferralNote && (
            <p
              style={{
                textAlign: "center",
                color: "var(--vs-muted)",
                fontSize: 13,
                maxWidth: 640,
                margin: "0 auto",
                lineHeight: 1.6,
              }}
            >
              <T k="mining.referralNote" />
            </p>
          )}
        </section>

        {/* Mining */}
        <section className="vs-section" style={{ paddingTop: 0 }}>
          <h2 style={{ fontSize: "clamp(1.4rem, 4vw, 2rem)", margin: "0 0 8px", textAlign: "center" }}>
            <T k="mining.miningTitle" />
          </h2>
          <p
            style={{
              textAlign: "center",
              color: "var(--vs-muted)",
              fontSize: 15,
              maxWidth: 640,
              margin: "0 auto 28px",
              lineHeight: 1.7,
            }}
          >
            <T k="mining.miningSub" />
          </p>
          <MiningDePinCards category="mining" />
        </section>

        {/* DePIN */}
        <section className="vs-section" style={{ paddingTop: 0 }}>
          <h2 style={{ fontSize: "clamp(1.4rem, 4vw, 2rem)", margin: "0 0 8px", textAlign: "center" }}>
            <T k="mining.depinTitle" />
          </h2>
          <p
            style={{
              textAlign: "center",
              color: "var(--vs-muted)",
              fontSize: 15,
              maxWidth: 640,
              margin: "0 auto 28px",
              lineHeight: 1.7,
            }}
          >
            <T k="mining.depinSub" />
          </p>
          <MiningDePinCards category="depin" />
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
