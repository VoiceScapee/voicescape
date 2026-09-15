"use client";

/**
 * InstallAppButton — shows a native "Install app" button when the browser
 * fires `beforeinstallprompt` (Chrome/Edge on desktop + Android).
 * Firefox, desktop Safari, and iOS browsers never fire that event, so those
 * users get a manual install hint instead of nothing. Hidden when the app
 * is already installed (standalone display mode).
 */

import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type ManualHint = "firefox" | "safari" | "ios" | null;

const HINT_COPY: Record<Exclude<ManualHint, null>, string> = {
  firefox:
    "In Firefox: open the page menu (☰) and choose “Install”, or look for the install icon in the address bar.",
  safari: "In Safari: choose File → Add to Dock to install Voicescape as an app.",
  ios: "On iPhone or iPad: tap Share → Add to Home Screen to install Voicescape.",
};

const HINT_LABEL: Record<Exclude<ManualHint, null>, string> = {
  firefox: "Firefox",
  safari: "Safari",
  ios: "iPhone or iPad",
};

export default function InstallAppButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [manualHint, setManualHint] = useState<ManualHint>(null);
  const [hintOpen, setHintOpen] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(display-mode: standalone)").matches) {
      setInstalled(true);
      return;
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    // Firefox, desktop Safari, and iOS browsers never fire
    // beforeinstallprompt — after a grace period with no prompt event, offer
    // those users a manual install hint instead of rendering nothing.
    const ua = navigator.userAgent;
    const isIOS =
      /iPhone|iPad|iPod/i.test(ua) ||
      (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
    const isFirefox =
      /firefox/i.test(ua) && !/seamonkey/i.test(ua) && !isIOS;
    const isSafariDesktop =
      !isIOS &&
      !isFirefox &&
      /safari/i.test(ua) &&
      !/chrome|chromium|crios|edg|opr\/|fxios|android/i.test(ua);
    const hintTimer = window.setTimeout(() => {
      if (isIOS) setManualHint("ios");
      else if (isFirefox) setManualHint("firefox");
      else if (isSafariDesktop) setManualHint("safari");
    }, 2000);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      window.clearTimeout(hintTimer);
    };
  }, []);

  if (installed) return null;

  if (deferred) {
    const install = async () => {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === "accepted") setDeferred(null);
    };

    return (
      <button
        onClick={install}
        className="vs-btn vs-btn-ghost"
        style={{ padding: "12px 20px", fontSize: 14 }}
        aria-label="Install the Voicescape app"
      >
        ⬇ Install app
      </button>
    );
  }

  if (manualHint) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 6,
        }}
      >
        <button
          onClick={() => setHintOpen((v) => !v)}
          className="vs-btn vs-btn-ghost"
          style={{ padding: "12px 20px", fontSize: 14 }}
          aria-label={`How to install the Voicescape app in ${HINT_LABEL[manualHint]}`}
          aria-expanded={hintOpen}
        >
          ⬇ Install app
        </button>
        {hintOpen && (
          <p
            style={{
              fontSize: 12,
              opacity: 0.8,
              maxWidth: 240,
              textAlign: "right",
              margin: 0,
            }}
          >
            {HINT_COPY[manualHint]}
          </p>
        )}
      </div>
    );
  }

  return null;
}
