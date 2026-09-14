/**
 * Shared renderer for the legal documents (/terms, /privacy).
 *
 * Renders the section data from lib/legal/legal.ts in plain, readable
 * typography matching the site's glass aesthetic. The English version is
 * the governing version — legal text is intentionally not translated.
 */
import Navbar from "@/components/Navbar";
import Logo from "@/components/Logo";
import BuiltOnHedera from "@/components/BuiltOnHedera";
import { WalletConnect } from "@/components/WalletConnect";
import LegalLinks from "@/components/LegalLinks";
import type { LegalDoc } from "@/lib/legal/legal";

export default function LegalDocPage({ doc }: { doc: LegalDoc }) {
  return (
    <main style={{ minHeight: "100vh", background: "var(--vs-bg)" }}>
      <Navbar right={<WalletConnect />} />
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "48px 18px 72px" }}>
        <div style={{ marginBottom: 36 }}>
          <h1
            style={{
              fontSize: "clamp(1.8rem, 5vw, 2.6rem)",
              margin: "0 0 8px",
              fontFamily: "var(--font-display)",
            }}
          >
            {doc.title}
          </h1>
          <p className="vs-mono" style={{ color: "var(--vs-muted)", margin: 0, fontSize: 13 }}>
            Effective {doc.effectiveDate}
          </p>
        </div>

        <p style={{ color: "var(--vs-muted)", lineHeight: 1.7, fontSize: 16 }}>{doc.intro}</p>

        <div
          className="vs-glass"
          style={{
            padding: "28px 28px 8px",
            marginTop: 24,
            borderRadius: 16,
          }}
        >
          {doc.sections.map((s) => (
            <section key={s.heading} style={{ marginBottom: 28 }}>
              <h2 style={{ fontSize: 19, margin: "0 0 12px" }}>{s.heading}</h2>
              {s.paragraphs.map((p, i) => (
                <p key={i} style={{ lineHeight: 1.75, fontSize: 15, margin: "0 0 12px" }}>
                  {p}
                </p>
              ))}
              {s.bullets && (
                <ul style={{ margin: "0 0 12px", paddingLeft: 22, lineHeight: 1.75, fontSize: 15 }}>
                  {s.bullets.map((b, i) => (
                    <li key={i} style={{ marginBottom: 6 }}>
                      {b}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>

        <p style={{ color: "var(--vs-muted)", fontSize: 13, marginTop: 24, lineHeight: 1.6 }}>
          These documents are provided in English. The English version is the
          governing version.
        </p>

        <footer
          style={{
            borderTop: "1px solid var(--vs-border)",
            padding: "32px 24px",
            textAlign: "center",
            color: "var(--vs-muted)",
            fontSize: 13,
            marginTop: 48,
          }}
        >
          <div style={{ marginBottom: 12 }}>
            <Logo size={24} />
          </div>
          <LegalLinks />
          <BuiltOnHedera />
        </footer>
      </div>
    </main>
  );
}
