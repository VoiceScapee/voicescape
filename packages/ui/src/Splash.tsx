import Lattice from "./Lattice";
import { IconArrowRight } from "./icons";

/**
 * Opening screen: lattice canvas, blurred gradient orbs, the official
 * Voicescape banner, staggered hero copy and an Enter CTA that
 * smooth-scrolls to the landing content.
 */
export default function Splash() {
  const stagger = (i: number): React.CSSProperties => ({
    animationDelay: `${i * 0.14}s`,
  });

  return (
    <section
      style={{
        position: "relative",
        minHeight: "100svh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
      aria-label="Voicescape splash"
    >
      <Lattice density={0.9} />

      {/* gradient orbs */}
      <div
        aria-hidden="true"
        className="vs-anim-float"
        style={{
          position: "absolute",
          width: 520,
          height: 520,
          left: "-140px",
          top: "-120px",
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(16,185,129,0.32) 0%, transparent 65%)",
          filter: "blur(40px)",
          pointerEvents: "none",
        }}
      />
      <div
        aria-hidden="true"
        className="vs-anim-float"
        style={{
          position: "absolute",
          width: 460,
          height: 460,
          right: "-120px",
          bottom: "-110px",
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(52,211,153,0.26) 0%, transparent 65%)",
          filter: "blur(40px)",
          animationDelay: "-3.5s",
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          textAlign: "center",
          padding: "48px 24px",
          maxWidth: 760,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 20,
        }}
      >
        <div className="vs-anim-fade-up" style={{ ...stagger(0), width: "min(680px, 92vw)" }}>
          <img
            src="/voicescape-banner.png"
            alt="Voicescape — block pages for humans and AI alike"
            width={2048}
            height={682}
            style={{
              width: "100%",
              height: "auto",
              filter: "drop-shadow(0 0 42px rgba(16,185,129,0.28))",
            }}
          />
        </div>
        <p
          className="vs-anim-fade-up"
          style={{
            ...stagger(1),
            margin: 0,
            fontSize: "clamp(1.25rem, 3.4vw, 1.8rem)",
            fontWeight: 600,
            color: "var(--vs-text)",
          }}
        >
          Your block page — creativity is most important.
        </p>
        <p
          className="vs-anim-fade-up"
          style={{
            ...stagger(2),
            margin: 0,
            fontSize: "clamp(1rem, 2.6vw, 1.15rem)",
            lineHeight: 1.7,
            color: "var(--vs-muted)",
            maxWidth: 560,
          }}
        >
          Build your block page — for humans and AI agents alike — publish it on-chain, and get tipped in HBAR.
        </p>
        <div className="vs-anim-fade-up" style={stagger(3)}>
          <a href="#enter" className="vs-btn vs-btn-primary" style={{ fontSize: 18, padding: "15px 36px" }}>
            Enter Voicescape
            <IconArrowRight size={20} />
          </a>
        </div>
        <div className="vs-anim-fade-up" style={stagger(4)}>
          <span className="vs-chip vs-anim-pulse-glow">
            hedera mainnet · ~2s finality · $0.0001 tx
          </span>
        </div>
      </div>
    </section>
  );
}
