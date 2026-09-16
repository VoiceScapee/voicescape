import Splash from "@/components/Splash";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import BuiltOnHedera from "@/components/BuiltOnHedera";
import ExternalLink from "@/components/ExternalLink";
import { T } from "@/components/T";
import { WalletConnect } from "@/components/WalletConnect";
import { OnboardingTrigger } from "@/components/OnboardingTrigger";
import { DateStrip } from "@/components/landing/DateStrip";
import { ChainPulseStats } from "@/components/landing/ChainPulseStats";
import { Headlines } from "@/components/landing/Headlines";
import { ChatPreview } from "@/components/landing/ChatPreview";
import { FeaturedBlockpages } from "@/components/landing/FeaturedBlockpages";

const SERIF = "Georgia, 'Times New Roman', serif";

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
 * hero (eyebrow, gradient H1, sub, CTAs, 98/2 split strip) → community pulse
 * (live on-chain stats) → Hedera headlines (live /api/pulse) → happening in
 * the lobby (live chat preview) → founder quote (serif) → minimal footer.
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
          right={
            <WalletConnect />
          }
        />

        {/* Slim date strip — no ticking boxes */}
        <DateStrip />

        {/* Hero */}
        <section className="vs-section" style={{ textAlign: "center", paddingTop: 34 }}>
          <span className="vs-eyebrow" style={{ marginBottom: 22 }}>
            <T k="brand.eyebrow" />
          </span>
          <h1 style={{ fontSize: "clamp(34px, 7.5vw, 58px)", maxWidth: "16em", margin: "0 auto" }}>
            <T k="landing.brandH1a" />
            <br />
            <span className="vs-gradient-text"><T k="landing.brandH1b" /></span>
          </h1>
          <p style={{ color: "var(--vs-muted)", fontSize: "16.5px", lineHeight: 1.55, maxWidth: "34em", margin: "18px auto 26px" }}>
            <T k="landing.brandSub" />
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <Link
              href="/builder"
              className="vs-btn vs-btn-primary"
              style={{ padding: "13px 26px", fontSize: 16, textDecoration: "none" }}
            >
              <T k="landing.brandBuildCta" />
            </Link>
            <Link
              href="/explore"
              className="vs-btn vs-btn-ghost"
              style={{ padding: "13px 26px", fontSize: 16, textDecoration: "none" }}
            >
              <T k="landing.brandExploreCta" />
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

        {/* Featured blockpages — curated, ranked live by followers + badges */}
        <FeaturedBlockpages />

        {/* Founder quote — serif is reserved for human-voice moments */}
        <section className="vs-section" style={{ paddingTop: 0 }}>
          <blockquote
            style={{
              fontFamily: SERIF,
              fontStyle: "italic",
              fontSize: 21,
              lineHeight: 1.55,
              color: "#e8e4f5",
              maxWidth: "32em",
              margin: "0 auto",
              textAlign: "center",
            }}
          >
            <T k="landing.founderQuote" />
          </blockquote>
          <p
            className="vs-mono"
            style={{
              fontSize: 11,
              color: "var(--vs-muted)",
              margin: "12px 0 0",
              textAlign: "center",
              letterSpacing: "0.06em",
            }}
          >
            <T k="landing.founderQuoteBy" />
          </p>
        </section>

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
                  style={{ color: "#cfc2ff", textDecoration: "none", margin: "0 8px" }}
                >
                  <T k={l.k} />
                </ExternalLink>
              ) : (
                <Link
                  key={l.k}
                  href={l.href}
                  style={{ color: "#cfc2ff", textDecoration: "none", margin: "0 8px" }}
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
