/**
 * "New to Web3? Start here" — the plain-language dApp explainer.
 *
 * Lives on the landing page for logged-out visitors. No jargon: what a
 * dApp is, what a wallet is, why none of your data sits on our servers.
 */
import Link from "next/link";
import { T } from "@/components/T";
import { IconArrowRight, IconCheck, IconLink, IconTip } from "@/components/icons";
import type { I18nKey } from "@/lib/i18n/dictionaries";

const CARDS: { icon: typeof IconLink; titleKey: I18nKey; bodyKey: I18nKey }[] = [
  { icon: IconLink, titleKey: "landing.new1t", bodyKey: "landing.new1b" },
  { icon: IconTip, titleKey: "landing.new2t", bodyKey: "landing.new2b" },
  { icon: IconCheck, titleKey: "landing.new3t", bodyKey: "landing.new3b" },
];

export function NewToWeb3() {
  return (
    <section className="vs-section" style={{ paddingTop: 0 }}>
      <p className="vs-label" style={{ textAlign: "center" }}>
        <T k="landing.newLabel" />
      </p>
      <h2
        style={{
          fontSize: "clamp(1.6rem, 4.5vw, 2.4rem)",
          margin: "12px 0 12px",
          textAlign: "center",
        }}
      >
        <T k="landing.newTitle" />
      </h2>
      <p
        style={{
          textAlign: "center",
          color: "var(--vs-muted)",
          fontSize: 16,
          maxWidth: 640,
          margin: "0 auto 32px",
          lineHeight: 1.7,
        }}
      >
        <T k="landing.newSub" />
      </p>
      <div className="vs-grid-2" style={{ marginBottom: 28 }}>
        {CARDS.map((c) => (
          <div key={c.titleKey} className="vs-card" style={{ display: "flex", gap: 18 }}>
            <div
              style={{
                flexShrink: 0,
                width: 48,
                height: 48,
                borderRadius: 12,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "linear-gradient(135deg, rgba(130,89,239,0.25), rgba(145,168,255,0.18))",
                border: "1px solid var(--vs-border)",
                color: "var(--vs-cyan)",
              }}
            >
              <c.icon size={24} />
            </div>
            <div>
              <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>
                <T k={c.titleKey} />
              </h3>
              <p style={{ margin: 0, lineHeight: 1.7, color: "var(--vs-muted)", fontSize: 15 }}>
                <T k={c.bodyKey} />
              </p>
            </div>
          </div>
        ))}
      </div>
      <div style={{ textAlign: "center" }}>
        <Link
          href="/builder"
          className="vs-btn vs-btn-primary"
          style={{ padding: "14px 32px", fontSize: 16, textDecoration: "none" }}
        >
          <T k="landing.newCta" />
          <IconArrowRight size={18} />
        </Link>
      </div>
    </section>
  );
}
