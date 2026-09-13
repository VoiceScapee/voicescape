"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Lattice from "./Lattice";
import { IconArrowRight, IconChevronDown } from "./icons";
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
 * The splash is the first viewport of the landing flow — not a gate. The
 * user can scroll DOWN into the landing content and back UP to the splash
 * freely; only an explicit Enter click dismisses the splash (it unmounts
 * and is skipped for the rest of the session).
 */
export default function Splash() {
  const [entered, setEntered] = useState(false);

  // Skip the splash if the user already entered this session.
  // Done in an effect (not render) to keep SSR and first paint identical.
  useEffect(() => {
    if (hasEntered()) setEntered(true);
  }, []);

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

      {/* Scroll cue: the splash is the first viewport of a scrollable flow. */}
      <div
        aria-hidden="true"
        className="vs-anim-fade-up"
        style={{
          ...stagger(5),
          position: "absolute",
          bottom: 20,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          color: "var(--vs-muted)",
          opacity: 0.75,
          pointerEvents: "none",
        }}
      >
        <span className="vs-anim-float" style={{ display: "inline-flex" }}>
          <IconChevronDown size={28} />
        </span>
      </div>
    </section>
  );
}
