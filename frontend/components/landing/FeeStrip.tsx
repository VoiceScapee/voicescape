/**
 * The 2% fee / on-chain tipping explainer strip.
 *
 * Lives on /new-to-web3 only (the new-users page) — not on the landing.
 * Explains the 98/2 split in plain language: the tip jar Stripe can't do.
 */
import { T } from "@/components/T";

export function FeeStrip() {
  return (
    <section
      style={{
        background: "var(--vs-bg2)",
        border: "1px solid var(--vs-border)",
        borderRadius: 16,
        marginBottom: 8,
      }}
    >
      <div className="vs-section" style={{ textAlign: "center", paddingTop: 40, paddingBottom: 40 }}>
        <p className="vs-label"><T k="landing.feeLabel" /></p>
        <p style={{ fontSize: "clamp(1.2rem, 3.5vw, 1.6rem)", fontWeight: 700, margin: "12px 0 8px" }}>
          <T k="landing.feeTitle1" /> <span className="vs-gradient-text"><T k="landing.feeTitle2" /></span> <T k="landing.feeTitle3" />
        </p>
        <p style={{ fontSize: 17, fontWeight: 600, margin: "0 0 12px", color: "var(--vs-text)" }}>
          <T k="landing.feeWedge" />
        </p>
        <p style={{ lineHeight: 1.7, color: "var(--vs-muted)", fontSize: 15, margin: 0, maxWidth: 640, marginLeft: "auto", marginRight: "auto" }}>
          <T k="landing.feeNote" />
        </p>
        <p style={{ lineHeight: 1.7, color: "var(--vs-muted)", fontSize: 15, margin: "12px 0 0", maxWidth: 640, marginLeft: "auto", marginRight: "auto" }}>
          <T k="landing.feeCompare" />
        </p>
      </div>
    </section>
  );
}
