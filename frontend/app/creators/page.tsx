/**
 * /creators — the creator-earnings comparison page.
 *
 * The honest pitch for why creators earn more on Voicescape than on
 * traditional platforms: 98/2 on-chain split, instant settlement, no
 * thresholds, no gates, no fee stack. Every number below was checked
 * against the platforms' own fee pages in September 2026; the honest
 * caveats (volatility, cash-out fees, wallet needed) are stated on the
 * page itself — never hidden.
 *
 * Copy is plain English (like page metadata) rather than i18n keys:
 * mistranslated fee claims would be worse than untranslated ones.
 */
import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import Logo from "@/components/Logo";
import BuiltOnHedera from "@/components/BuiltOnHedera";
import LegalLinks from "@/components/LegalLinks";
import { WalletConnect } from "@/components/WalletConnect";

export const metadata: Metadata = {
  title: "For Creators — Keep 98% of Everything | Voicescape",
  description:
    "Tips and sales settle on-chain in seconds with a 98/2 split. No thresholds, no monthly batches, no 30% tip taxes. See how Voicescape compares to Patreon, Ko-fi, YouTube, Twitch and TikTok.",
};

const SERIF = "Georgia, 'Times New Roman', serif";

const card: React.CSSProperties = {
  background: "var(--vs-card)",
  border: "1px solid var(--vs-border)",
  borderRadius: 16,
  padding: "22px 20px",
};

const statNum: React.CSSProperties = {
  fontSize: 34,
  fontWeight: 800,
  lineHeight: 1.1,
  margin: "0 0 6px",
};

const muted: React.CSSProperties = {
  color: "var(--vs-muted)",
  fontSize: 15,
  lineHeight: 1.6,
};

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 13,
  color: "var(--vs-muted)",
  fontWeight: 600,
  borderBottom: "1px solid var(--vs-border)",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: 15,
  borderBottom: "1px solid var(--vs-border)",
  whiteSpace: "nowrap",
};

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="vs-section" style={{ paddingTop: 44 }}>
      <span className="vs-eyebrow" style={{ marginBottom: 14 }}>
        {eyebrow}
      </span>
      <h2
        style={{
          fontSize: "clamp(24px, 5vw, 34px)",
          margin: "0 0 14px",
          maxWidth: "22em",
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function CreatorsPage() {
  return (
    <main style={{ minHeight: "100vh", background: "var(--vs-bg)" }}>
      <Navbar right={<WalletConnect />} />
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "32px 18px 72px" }}>
        {/* Hero */}
        <section className="vs-section" style={{ textAlign: "center", paddingTop: 26 }}>
          <span className="vs-eyebrow" style={{ marginBottom: 20 }}>
            For creators
          </span>
          <h1 style={{ fontSize: "clamp(34px, 7.5vw, 58px)", maxWidth: "16em", margin: "0 auto" }}>
            Keep <span className="vs-gradient-text">98%</span> of everything you earn.
          </h1>
          <p style={{ ...muted, fontSize: "16.5px", maxWidth: "36em", margin: "18px auto 26px" }}>
            Tips and sales on Voicescape settle on-chain in seconds — 98% straight
            to your wallet, 2% to the platform, enforced by the contract itself.
            No thresholds. No monthly batches. No 30% tax on your thank-yous.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <Link
              href="/builder"
              className="vs-btn vs-btn-primary"
              style={{ padding: "13px 26px", fontSize: 16, textDecoration: "none" }}
            >
              Build your blockpage
            </Link>
            <Link
              href="/new-to-web3"
              className="vs-btn vs-btn-ghost"
              style={{ padding: "13px 26px", fontSize: 16, textDecoration: "none" }}
            >
              New to Web3? Start here
            </Link>
          </div>
          <p className="vs-mono" style={{ ...muted, fontSize: 13, marginTop: 22 }}>
            98/2 split · atomic on-chain · verifiable on HashScan
          </p>
        </section>

        {/* The $1 test */}
        <Section eyebrow="The $1 test" title={<>What a $1 tip becomes, platform by platform.</>}>
          <p style={{ ...muted, margin: "0 0 18px", maxWidth: "40em" }}>
            Most tips are small — and small is exactly where card-rail fees do the
            most damage. Here&apos;s what the creator actually keeps from a single
            $1 tip, after platform fees and standard card processing:
          </p>
          <div style={{ overflowX: "auto", ...card, padding: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
              <thead>
                <tr>
                  <th style={th}>Platform</th>
                  <th style={th}>Creator keeps</th>
                  <th style={th}>Why</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ ...td, fontWeight: 700 }}><span className="vs-gradient-text">Voicescape — $0.98</span></td>
                  <td style={td}>98%</td>
                  <td style={{ ...td, whiteSpace: "normal" }}>2% flat · network fee ≈ $0.0001</td>
                </tr>
                <tr>
                  <td style={td}>Ko-fi — $0.67</td>
                  <td style={td}>67%</td>
                  <td style={{ ...td, whiteSpace: "normal" }}>0% platform fee, but Stripe takes 2.9% + $0.30</td>
                </tr>
                <tr>
                  <td style={td}>Buy Me a Coffee — $0.62</td>
                  <td style={td}>62%</td>
                  <td style={{ ...td, whiteSpace: "normal" }}>5% + Stripe&apos;s 2.9% + $0.30</td>
                </tr>
                <tr>
                  <td style={td}>Patreon — ~$0.57</td>
                  <td style={td}>~57%</td>
                  <td style={{ ...td, whiteSpace: "normal" }}>10% + processing + payout fees</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p style={{ ...muted, fontSize: 13, marginTop: 12 }}>
            Platform fees plus standard card processing (2.9% + $0.30), checked
            September 2026. Ko-fi&apos;s 0% only beats our 2% on tips above ~$33 —
            below that, the flat 30¢ costs creators more than our whole cut.
          </p>
        </Section>

        {/* Support efficiency */}
        <Section
          eyebrow="Support efficiency"
          title={<>Of every dollar your fan meant to give you, how much survives?</>}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 14,
            }}
          >
            <div style={card}>
              <p style={{ ...statNum }}><span className="vs-gradient-text">98¢</span></p>
              <p style={{ ...muted, margin: 0 }}>Voicescape — a $1 tip costs the fan $1</p>
            </div>
            <div style={card}>
              <p style={statNum}>71¢</p>
              <p style={{ ...muted, margin: 0 }}>Twitch Bits — fan pays $1.40, streamer gets $1.00</p>
            </div>
            <div style={card}>
              <p style={statNum}>70¢</p>
              <p style={{ ...muted, margin: 0 }}>YouTube Super Chat — YouTube takes 30% of your tip</p>
            </div>
            <div style={card}>
              <p style={statNum}>~57¢</p>
              <p style={{ ...muted, margin: 0 }}>$1 Patreon pledge after 10% + processing</p>
            </div>
          </div>
          <p style={{ ...muted, marginTop: 18, maxWidth: "40em" }}>
            Platforms sell tipping as generosity, then tax it. Here, a dollar of
            support is a dollar of support.
          </p>
        </Section>

        {/* Speed */}
        <Section eyebrow="Instant" title={<>Money in seconds. Not next month.</>}>
          <div style={{ display: "grid", gap: 12, maxWidth: "40em" }}>
            {[
              ["Voicescape — seconds", "Tip or sale settles on-chain (~seconds). 98% lands in your wallet in the same transaction. No hold, no minimum, no payout button."],
              ["Ko-fi — near-instant", "Tips go straight to your Stripe/PayPal. Honest credit: they're fast too — but the 30¢ flat fee eats small tips."],
              ["Substack — ~2 days", "Stripe's standard rolling payouts. Decent speed, 10% platform fee off the top."],
              ["Patreon — next month", "Pledges process 1st–5th, balance available ~5th–6th, then 1–5 business days to your bank. iOS pledges can pend up to 75 days."],
              ["Twitch — weeks + $50 gate", "Payouts lag the month, and nothing moves until you clear the $50 minimum."],
              ["YouTube — next month + $100 gate", "Earnings paid 21st–26th of the following month, only after a $100 threshold. Small creators wait months for a first payout."],
            ].map(([t, d]) => (
              <div key={t} style={{ ...card, padding: "16px 18px" }}>
                <p style={{ fontWeight: 700, margin: "0 0 4px" }}>{t}</p>
                <p style={{ ...muted, margin: 0, fontSize: 14 }}>{d}</p>
              </div>
            ))}
          </div>
          <blockquote
            style={{
              fontFamily: SERIF,
              fontStyle: "italic",
              fontSize: 19,
              lineHeight: 1.5,
              borderLeft: "3px solid var(--vs-accent)",
              paddingLeft: 18,
              margin: "26px 0 0",
              maxWidth: "32em",
              color: "var(--vs-text)",
            }}
          >
            “One day, we&apos;d love for you to wrap up your stream and already
            have the money you earned from that stream in your wallet.”
            <footer style={{ ...muted, fontSize: 14, marginTop: 8, fontStyle: "normal" }}>
              — Twitch, on their payout roadmap. On Voicescape, that&apos;s just how it works.
            </footer>
          </blockquote>
        </Section>

        {/* The $1 economy */}
        <Section eyebrow="The $1 economy" title={<>The $1 tip died on card rails. It lives here.</>}>
          <p style={{ ...muted, maxWidth: "40em", margin: "0 0 14px" }}>
            $1 pledges were once the backbone of Patreon — then a fee change made
            a $1 pledge cost the patron $1.38, gutting small pledges across the
            industry. Every card-rails platform since has priced the small tip out
            of existence with flat per-transaction fees.
          </p>
          <p style={{ ...muted, maxWidth: "40em", margin: 0 }}>
            Our fee is a percentage, not a flat tax — so a $1 tip stays viable.
            More fans can afford to tip, more often. Small support, at scale, is
            a business model here.
          </p>
        </Section>

        {/* No gates */}
        <Section eyebrow="No gates" title={<>Earn from fan #1. No audition.</>}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 14,
            }}
          >
            <div style={card}>
              <p style={{ fontWeight: 700, margin: "0 0 6px" }}>YouTube</p>
              <p style={{ ...muted, margin: 0, fontSize: 14 }}>1,000 subscribers + 4,000 watch hours before you earn anything (8,000 hours for new applicants from 2027).</p>
            </div>
            <div style={card}>
              <p style={{ fontWeight: 700, margin: "0 0 6px" }}>TikTok</p>
              <p style={{ ...muted, margin: 0, fontSize: 14 }}>10,000 followers to enter the Creativity Program. Legacy fund paid $0.02–$0.04 per 1,000 views.</p>
            </div>
            <div style={card}>
              <p style={{ fontWeight: 700, margin: "0 0 6px" }}>Twitch</p>
              <p style={{ ...muted, margin: 0, fontSize: 14 }}>Affiliate status: 50 followers plus streaming quotas — before a single Bit pays out.</p>
            </div>
            <div style={{ ...card, borderColor: "var(--vs-accent)" }}>
              <p style={{ fontWeight: 700, margin: "0 0 6px" }}>
                <span className="vs-gradient-text">Voicescape</span>
              </p>
              <p style={{ ...muted, margin: 0, fontSize: 14 }}>Own a wallet. That&apos;s the whole gate. Tip #1 pays.</p>
            </div>
          </div>
        </Section>

        {/* Built for the middle */}
        <Section eyebrow="Built for the middle" title={<>The industry serves the top. We serve everyone else.</>}>
          <p style={{ ...muted, maxWidth: "40em", margin: "0 0 14px" }}>
            CreatorIQ&apos;s 2026 State of Creators report: <strong>67% of creators
            earn under $10,000 a year</strong>, while the top 10% capture 62% of
            all creator payments. The #1 barrier creators name is platform
            algorithm volatility. The machine serves the top, starves the middle,
            and changes the rules without warning.
          </p>
          <p style={{ ...muted, maxWidth: "40em", margin: 0 }}>
            Run the small-creator math: 100 real fans tipping $1 each ={" "}
            <strong>$98 here</strong>. On YouTube, 100 fans earn you $0 — you
            haven&apos;t passed the gate. Our economics work at fan #1. Theirs
            work at scale.
          </p>
        </Section>

        {/* The ratchet */}
        <Section eyebrow="The ratchet" title={<>Their split is a policy. Ours is code.</>}>
          <p style={{ ...muted, maxWidth: "40em", margin: "0 0 14px" }}>
            Twitch moved streamers from 70/30 to 50/50. Patreon went from 5% to
            10% for new creators. YouTube keeps 55% of Shorts revenue. Every
            platform&apos;s &quot;creator-friendly&quot; split gets revised against
            the creator once the platform has leverage.
          </p>
          <p style={{ ...muted, maxWidth: "40em", margin: 0 }}>
            The 98/2 split isn&apos;t our policy — it&apos;s enforced by the
            Tips contract and visible on HashScan. No board meeting can change
            it. And because we&apos;re a web app, not an app-store app, there&apos;s
            no in-app purchase for Apple to take 30% of. That tax simply doesn&apos;t
            exist here.
          </p>
        </Section>

        {/* Finality */}
        <Section eyebrow="Final" title={<>Nobody can take it back — from either side.</>}>
          <p style={{ ...muted, maxWidth: "40em", margin: "0 0 14px" }}>
            Card tips can be charged back and clawed out of your balance weeks
            later. Platform balances can be frozen, demonetized, or held for
            review. Here, tips settle on-chain straight into your own wallet — we
            never hold your money, so we <em>can&apos;t</em> freeze it, and no
            chargeback exists.
          </p>
          <p style={{ ...muted, maxWidth: "40em", margin: 0 }}>
            The flip side, stated plainly: fans can&apos;t get refunds either.
            Marketplace sales are direct wallet-to-wallet — trust comes from the
            public on-chain record, not buyer protection.
          </p>
        </Section>

        {/* Honest caveats */}
        <Section eyebrow="Honest caveats" title={<>What we won't pretend.</>}>
          <div style={{ ...card, maxWidth: "40em" }}>
            <ul style={{ ...muted, margin: 0, paddingLeft: 20, display: "grid", gap: 10 }}>
              <li><strong>HBAR moves.</strong> It&apos;s a volatile asset — down ~68% over the past year. A tip held in HBAR moves with the market. You choose when to convert.</li>
              <li><strong>Cashing out costs.</strong> Converting HBAR to dollars means exchange fees and spread (roughly ~1% on major exchanges).</li>
              <li><strong>Fans need a Hedera wallet</strong> (like HashPack) to tip. That&apos;s real friction, and we&apos;re upfront about it.</li>
              <li><strong>No subscriptions yet.</strong> Today it&apos;s tips and marketplace sales — we don&apos;t do recurring memberships.</li>
            </ul>
          </div>
        </Section>

        {/* Closing CTA */}
        <section className="vs-section" style={{ textAlign: "center", paddingTop: 56 }}>
          <h2 style={{ fontSize: "clamp(26px, 6vw, 40px)", maxWidth: "18em", margin: "0 auto 14px" }}>
            Your fans&apos; money should reach <span className="vs-gradient-text">you</span>.
          </h2>
          <p style={{ ...muted, maxWidth: "32em", margin: "0 auto 26px" }}>
            Build your blockpage free, share it anywhere, and keep 98% of
            everything it earns — starting with the very first tip.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <Link
              href="/builder"
              className="vs-btn vs-btn-primary"
              style={{ padding: "13px 26px", fontSize: 16, textDecoration: "none" }}
            >
              Start building — it&apos;s free
            </Link>
            <Link
              href="/explore"
              className="vs-btn vs-btn-ghost"
              style={{ padding: "13px 26px", fontSize: 16, textDecoration: "none" }}
            >
              See blockpages
            </Link>
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
            marginTop: 40,
          }}
        >
          <div style={{ marginBottom: 12 }}>
            <Logo size={24} />
          </div>
          <p className="vs-mono" style={{ margin: "0 0 12px" }}>
            A raising tide raises all ships.
          </p>
          <LegalLinks />
          <BuiltOnHedera />
          <p style={{ fontSize: 12, marginTop: 12 }}>
            Fee comparisons checked September 2026 against the platforms&apos; own published rates.
          </p>
        </footer>
      </div>
    </main>
  );
}
