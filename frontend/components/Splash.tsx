"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Lattice from "./Lattice";
import { IconArrowRight } from "./icons";
import { T } from "./T";

const ENTERED_KEY = "vs_splash_entered";

function hasEntered(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(ENTERED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Opening screen: lattice canvas, blurred gradient orbs, the official
 * Voicescape logo lockup, staggered hero copy and an Enter CTA.
 *
 * The splash is a fixed full-viewport overlay — not a scrollable part of
 * the landing flow. Page scroll is locked while it is up, and only an
 * explicit Enter click dismisses it (it unmounts and is skipped for the
 * rest of the session).
 */
export default function Splash() {
  const [entered, setEntered] = useState(false);

  // Skip the splash if the user already entered this session.
  // Done in an effect (not render) to keep SSR and first paint identical.
  useEffect(() => {
    if (hasEntered()) setEntered(true);
  }, []);

  // Lock page scroll while the splash overlay is up; release it the
  // moment the user enters.
  useEffect(() => {
    if (entered) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [entered]);

  if (entered) return null;

  const handleEnter = () => {
    try {
      sessionStorage.setItem(ENTERED_KEY, "1");
    } catch {
      // sessionStorage unavailable — splash just shows again next load
    }
    setEntered(true);
    // Splash unmounts on the next paint; then glide to the content.
    requestAnimationFrame(() => {
      document.getElementById("enter")?.scrollIntoView({ behavior: "smooth" });
    });
  };

  const stagger = (i: number): React.CSSProperties => ({
    animationDelay: `${i * 0.14}s`,
  });

  return (
    <section
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        background:
          "radial-gradient(circle at 12% 5%, rgba(130, 89, 239, 0.18), transparent 26rem), radial-gradient(circle at 92% 18%, rgba(0, 49, 255, 0.13), transparent 30rem), linear-gradient(180deg, #0b0e16 0, #090b12 46%, #0c0f18 100%)",
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
          background: "radial-gradient(circle, rgba(130,89,239,0.32) 0%, transparent 65%)",
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
          background: "radial-gradient(circle, rgba(145,168,255,0.26) 0%, transparent 65%)",
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
          <Image
            src="/voicescape-logo.webp"
            alt="Voicescape — block pages for humans and AI alike"
            width={2736}
            height={912}
            priority
            style={{
              width: "100%",
              height: "auto",
              // The lockup's dark-navy background is baked in; screen blend
              // drops it so the logo melts into the splash background.
              mixBlendMode: "screen",
              filter: "drop-shadow(0 0 42px rgba(130,89,239,0.28))",
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
          <T k="splash.tagline" />
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
          <T k="splash.sub" />
        </p>
        <div className="vs-anim-fade-up" style={stagger(3)}>
          <button
            type="button"
            onClick={handleEnter}
            className="vs-btn vs-btn-primary"
            style={{ fontSize: 18, padding: "15px 36px", cursor: "pointer" }}
          >
            <T k="splash.enter" />
            <IconArrowRight size={20} />
          </button>
        </div>
        <div className="vs-anim-fade-up" style={stagger(4)}>
          <span className="vs-chip vs-anim-pulse-glow">
            <T k="splash.poweredBy" /> · <T k="splash.hederaSpecs" />
          </span>
        </div>
      </div>

    </section>
  );
}
