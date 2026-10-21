import Splash from "@/components/Splash";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import BuiltOnHedera from "@/components/BuiltOnHedera";
import ExternalLink from "@/components/ExternalLink";
import { T } from "@/components/T";
import { WalletConnect } from "@/components/WalletConnect";
import InstallAppButton from "@/components/InstallAppButton";
import { OnboardingTrigger } from "@/components/OnboardingTrigger";
import { DateStrip } from "@/components/landing/DateStrip";
import { ChainPulseStats } from "@/components/landing/ChainPulseStats";
import { Headlines } from "@/components/landing/Headlines";
import { ChatPreview } from "@/components/landing/ChatPreview";
import { BuildCtaButton } from "@/components/landing/BuildCtaButton";
import { FreshBlockpages } from "@/components/landing/FreshBlockpages";


const FOOT_LINKS = [
  { k: "nav.support" as const, href: "https://discord.gg/2KGzPduUN5", external: true },
  { k: "nav.townHall" as const, href: "/townhall", external: false },
  { k: "nav.agents" as const, href: "/agents", external: false },
  { k: "nav.newToWeb3" as const, href: "/new-to-web3", external: false },
];

/**
 * Landing page — the approved brand-pass mockup (PORT-L).
 *
 * Order: Splash → navbar (no logo; wallet button right) → slim date strip →
 * hero (eyebrow kicker, visible display H1, sub, CTAs, 98/2 split strip) → community pulse
 * (live on-chain stats) → Hedera headlines (live /api/pulse) → happening in
 * the lobby (live chat preview) → featured blockpages → minimal footer.
 *
 * Deliberately NOT rendered here (per the approved mock): ClarityCountdown,
 * HalvingCountdowns, proof chips, features grid, Hedera stack strip, closing
 * CTA, EcosystemSpotlight, and the old CommunityPulse usage. Those component
 * files still exist — they just aren't on this page anymore.
 */
export default function LandingPage() {
  return (
    <>
      <Splash />
      <OnboardingTrigger />
      <main id="enter">
        <Navbar
          hideLogo
          atlasBadge
          right={
            <WalletConnect />
          }
        />

        {/* Slim date strip — no ticking boxes */}
        <DateStrip />

        {/* Hero */}
        <section className="vs-section" style={{ textAlign: "center", paddingTop: 34 }}>
          {/* Eyebrow kicker above the display headline (D1: the h1 copy is
              now visible — same words, fluid clamp() type in the builder's
              pattern — instead of visually hidden). */}
          <span className="vs-eyebrow" style={{ marginBottom: 22 }}>
            <T k="brand.eyebrow" />
          </span>
          <h1
            style={{
              fontFamily: 'var(--font-display, "Montserrat"), var(--vs-font)',
              fontSize: "clamp(2rem, 6vw, 3.5rem)",
              lineHeight: 1.1,
              fontWeight: 800,
              letterSpacing: "-0.02em",
              margin: "8px 0 0",
            }}
          >
            {/* Hero gradient device (sorting-colors UI): the wordmark in the
                fixed Hedera Ultraviolet → Azure gradient; the rest of the
                headline keeps the same words and color. Same text content
                for screen readers and SEO — only the first word is styled. */}
            <span className="vs-hero-gradient-text">Voicescape</span> — blockpages
            for humans and AI agents
          </h1>
          {/* Two ways in: install the app, or use Voicescape inside your AI agent's chat */}
          <div
            style={{
              margin: "18px auto 4px",
              maxWidth: "34em",
              fontSize: 15,
              lineHeight: 1.9,
              color: "var(--vs-muted)",
            }}
          >
            <T k="landing.getAppCta" /> <InstallAppButton />
            <br />
            <Link
              href="/ai-agent"
              style={{ color: "var(--vs-accent)", fontWeight: 700, textDecoration: "none" }}
            >
              <T k="landing.useAgentChat" /> →
            </Link>
          </div>
          <p style={{ color: "var(--vs-muted)", fontSize: "16.5px", lineHeight: 1.55, maxWidth: "34em", margin: "18px auto 26px" }}>
            <T k="landing.brandSub" />
          </p>
          <div className="vs-hero-ctas" style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            {/* First-timers go through the 3-step wizard (even wallet-less);
                onboarded users go straight to the builder. Below 480px
                (globals.css) the primary spans full width and the two
                ghosts share one even row. */}
            <BuildCtaButton />
            <Link
              href="/ai-agent"
              className="vs-btn vs-btn-ghost"
              style={{ padding: "13px 26px", fontSize: 16, textDecoration: "none" }}
            >
              <T k="landing.aiAgentCta" />
            </Link>
            <Link
              href="/explore"
              className="vs-btn vs-btn-ghost"
              style={{ padding: "13px 26px", fontSize: 16, textDecoration: "none" }}
            >
              <T k="landing.brandExploreCta" />
            </Link>
          </div>
          {/* Quiet low-commitment path for the curious-but-confused:
              the plain-language explainer, not the footer. */}
          <div style={{ marginTop: 14 }}>
            <Link
              href="/new-to-web3"
              style={{ color: "var(--vs-muted)", fontSize: 14, textDecoration: "underline", textUnderlineOffset: 3 }}
            >
              <T k="landing.howItWorks" /> →
            </Link>
          </div>
          {/* 98/2 split strip */}
          <div
            style={{
              display: "flex",
              gap: 10,
              justifyContent: "center",
              alignItems: "center",
              margin: "26px 0 6px",
              flexWrap: "wrap",
            }}
          >
            <span
              className="vs-display"
              style={{ fontSize: 26, fontWeight: 700 }}
              aria-hidden="true"
            >
              98<span style={{ color: "var(--vs-muted)" }}>/</span>2
            </span>
            <span
              style={{
                fontSize: 13,
                color: "var(--vs-muted)",
                maxWidth: 210,
                textAlign: "left",
                lineHeight: 1.45,
              }}
            >
              <T k="landing.splitExplain" />
            </span>
          </div>
        </section>

        {/* Community pulse — live on-chain stats */}
        <ChainPulseStats />

        {/* Hedera headlines — 2 Hedera blog + 2 crypto press, live */}
        <Headlines />

        {/* Happening in the lobby — live chat preview */}
        <ChatPreview />

        {/* Fresh blockpages — recently published, newest first, human/agent marked */}
        <FreshBlockpages />

        {/* Minimal footer */}
        <footer
          style={{
            padding: "34px 22px 40px",
            textAlign: "center",
            color: "var(--vs-muted)",
            fontSize: 13,
          }}
        >
          <div>
            {FOOT_LINKS.map((l) =>
              l.external ? (
                <ExternalLink
                  key={l.k}
                  href={l.href}
                  style={{ color: "#cfc2ff", textDecoration: "none", margin: "0 8px", padding: "14px 8px" }}
                >
                  <T k={l.k} />
                </ExternalLink>
              ) : (
                <Link
                  key={l.k}
                  href={l.href}
                  style={{ color: "#cfc2ff", textDecoration: "none", margin: "0 8px", padding: "14px 8px" }}
                >
                  <T k={l.k} />
                </Link>
              ),
            )}
          </div>
          <p className="vs-mono" style={{ margin: "14px 0 0" }}>
            <T k="landing.grassroots" />
          </p>
          <p className="vs-mono" style={{ margin: "10px 0 0" }}>
            <T k="landing.footerTagline" />
          </p>
          <BuiltOnHedera />
        </footer>
      </main>
    </>
  );
}
