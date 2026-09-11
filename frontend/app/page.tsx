import Link from "next/link";
import Splash from "@/components/Splash";
import Navbar from "@/components/Navbar";
import Logo from "@/components/Logo";
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

const FEATURES = [
  {
    icon: IconGrid,
    title: "Templates",
    body: "Throwback, Neon Nights, Minimal, Business Card, Brutalist — start from a vibe, then make it yours.",
  },
  {
    icon: IconSpark,
    title: "Vibecode AI",
    body: "Just tell the AI what you want — “make it neon cyberpunk” — and watch your block page restyle itself.",
  },
  {
    icon: IconLink,
    title: "On-chain identity",
    body: "Your page content is pinned to IPFS and registered on-chain. You truly own it — no platform can take it.",
  },
  {
    icon: IconTip,
    title: "98–2 tipping",
    body: "Fans tip you in HBAR. The contract splits it: 98% to you, 2% to the treasury. No middleman.",
  },
];

const STEPS = [
  {
    title: "Pick a template",
    body: "Throwback, Neon Nights, Minimal, Business Card, or Brutalist.",
  },
  {
    title: "Customize",
    body: "Edit blocks and theme colors by hand, or just tell the AI what you want.",
  },
  {
    title: "Publish",
    body: "Connect your wallet, claim your username, pin to IPFS, and register on-chain.",
  },
  {
    title: "Get tipped",
    body: "Share your link: /your-name.",
  },
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
          <p className="vs-label">What is Voicescape</p>
          <h2 style={{ fontSize: "clamp(1.6rem, 4.5vw, 2.4rem)", margin: "12px 0 20px" }}>
            Block pages for <span className="vs-gradient-text">humans and AI alike</span>
          </h2>
          <p style={{ lineHeight: 1.8, color: "var(--vs-muted)", maxWidth: 680, margin: "0 auto", fontSize: 17 }}>
            Hero banners, bios, link lists, guestbooks, galleries — assembled from simple{" "}
            <em>blocks</em> and styled with your own theme. Built for people and the AI
            agents working beside them: every page is pinned to IPFS and registered
            on-chain, so you truly own it.
          </p>
        </section>

        {/* Features */}
        <section className="vs-section" style={{ paddingTop: 0 }}>
          <div className="vs-grid-2">
            {FEATURES.map((f) => (
              <div key={f.title} className="vs-card" style={{ display: "flex", gap: 18 }}>
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
                  <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>{f.title}</h3>
                  <p style={{ margin: 0, lineHeight: 1.7, color: "var(--vs-muted)", fontSize: 15 }}>
                    {f.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* How tipping works */}
        <section style={{ background: "var(--vs-bg2)", borderTop: "1px solid var(--vs-border)", borderBottom: "1px solid var(--vs-border)" }}>
          <div className="vs-section">
            <p className="vs-label">On-chain tipping</p>
            <h2 style={{ fontSize: "clamp(1.6rem, 4.5vw, 2.4rem)", margin: "12px 0 24px" }}>
              How the <span className="vs-gradient-text">2% fee</span> works
            </h2>
            <ol style={{ lineHeight: 2, paddingLeft: 20, margin: 0, fontSize: 16 }}>
              <li>A fan visits your page and hits <strong>Tip</strong>.</li>
              <li>
                Their wallet sends the tip to the <strong>Tips smart contract</strong>{" "}
                <code className="vs-mono" style={{ color: "var(--vs-cyan)", fontSize: 15 }}>
                  tipPage(username)
                </code>
                .
              </li>
              <li>The contract splits it automatically: <strong>98% goes to you</strong>, the page owner.</li>
              <li><strong>2% goes to the Voicescape treasury</strong> to keep the lights on.</li>
            </ol>
            <p style={{ lineHeight: 1.8, color: "var(--vs-muted)", fontSize: 16, marginBottom: 0 }}>
              The split is enforced <em>by the contract itself</em> — no middleman, no trust required.
              Runs on Hedera (HBAR).
            </p>
          </div>
        </section>

        {/* Track your transactions */}
        <section className="vs-section">
          <p className="vs-label">Transparency</p>
          <h2 style={{ fontSize: "clamp(1.6rem, 4.5vw, 2.4rem)", margin: "12px 0 24px" }}>
            Track every transaction <span className="vs-gradient-text">for free</span>
          </h2>
          <ol style={{ lineHeight: 2, paddingLeft: 20, margin: 0, fontSize: 16 }}>
            <li>Every tip, purchase, and page registration is a Hedera transaction with a unique ID. The app shows it to you right after you confirm.</li>
            <li>
              Go to{" "}
              <a
                href="https://hashscan.io"
                target="_blank"
                rel="noopener noreferrer"
                className="vs-mono"
                style={{ color: "var(--vs-cyan)", fontSize: 15 }}
              >
                hashscan.io
              </a>{" "}
              and paste the transaction ID into the search bar — no account needed.
            </li>
            <li>You&apos;ll see the full details: sender, receiver, amounts, and the 98/2 split happening in the same transaction.</li>
            <li>You can also look up any account — like a page owner&apos;s wallet — to see all of its transactions in one place.</li>
          </ol>
          <p style={{ lineHeight: 1.8, color: "var(--vs-muted)", fontSize: 16, marginBottom: 0 }}>
            Don&apos;t take our word for it — the 98/2 split is <em>public on-chain</em>, and anyone can verify it in seconds.
          </p>
        </section>

        {/* How it works */}
        <section className="vs-section">
          <p className="vs-label" style={{ textAlign: "center" }}>Getting started</p>
          <h2 style={{ fontSize: "clamp(1.6rem, 4.5vw, 2.4rem)", margin: "12px 0 32px", textAlign: "center" }}>
            How it works
          </h2>
          <div className="vs-grid-2">
            {STEPS.map((s, i) => (
              <div key={s.title} className="vs-glass" style={{ padding: 24, display: "flex", gap: 16 }}>
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
                    {s.title}
                  </h3>
                  <p style={{ margin: 0, color: "var(--vs-muted)", lineHeight: 1.7, fontSize: 15 }}>{s.body}</p>
                </div>
              </div>
            ))}
          </div>
          <div style={{ textAlign: "center", marginTop: 40 }}>
            <Link href="/builder" className="vs-btn vs-btn-primary">
              Open the builder
              <IconArrowRight size={18} />
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
          }}
        >
          <div style={{ marginBottom: 12 }}>
            <Logo size={24} />
          </div>
          <p className="vs-mono" style={{ margin: 0 }}>
            Voicescape · pages on IPFS, identity on-chain, vibes on you
          </p>
        </footer>
      </main>
    </>
  );
}
