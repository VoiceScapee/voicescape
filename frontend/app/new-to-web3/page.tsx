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
import LegalLinks from "@/components/LegalLinks";
import { WalletConnect } from "@/components/WalletConnect";
import { T } from "@/components/T";
import { NewToWeb3 } from "@/components/landing/NewToWeb3";
import { FeeStrip } from "@/components/landing/FeeStrip";
import { OnboardStepper } from "@/components/landing/OnboardStepper";

export const metadata: Metadata = {
  title: "New to Web3? Start here — Voicescape",
  description:
    "Crypto explained like a human: what a dApp is, why your wallet is your login, and why Hedera keeps fees at pennies, not dollars.",
};

export default function NewToWeb3Page() {
  return (
    <main style={{ minHeight: "100vh", background: "var(--vs-bg)" }}>
      <Navbar right={<WalletConnect />} />
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 18px 72px" }}>
        <NewToWeb3 />

        {/* On-chain tipping / 2% fee explainer — lives here only, not on the landing */}
        <FeeStrip />

        {/* Brand pass PORT-O: "Crypto, explained like a human" — the vertical
            onboarding stepper from the approved mock (step 1 done, step 2
            active, steps 3–4 upcoming). Live wiring (NewToWeb3 + FeeStrip)
            stays untouched above. */}
        <OnboardStepper />

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
          <LegalLinks />
          <BuiltOnHedera />
        </footer>
      </div>
    </main>
  );
}
