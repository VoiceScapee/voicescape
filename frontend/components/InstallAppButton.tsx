"use client";

/**
 * InstallAppButton — shows a native "Install app" button only when the
 * browser fires `beforeinstallprompt` (Chrome/Edge on desktop + Android).
 * Hidden when the app is already installed (standalone display mode).
 * iOS Safari users install via Share → Add to Home Screen, which needs no code.
 */

import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function InstallAppButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(display-mode: standalone)").matches) {
      setInstalled(true);
      return;
    }
    // iOS Safari never fires beforeinstallprompt — users install via
    // Share → Add to Home Screen instead.
    if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
      setIsIos(true);
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
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
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
        style={{ padding: "8px 20px", fontSize: 14 }}
        aria-label="Install the Voicescape app"
      >
        ⬇ Install app
      </button>
    );
  }

  // iOS: no install prompt exists — show the one-line manual hint instead
  // of hiding silently.
  if (isIos) {
    return (
      <span style={{ fontSize: 13, color: "var(--vs-muted)" }}>
        iPhone: Share <span aria-hidden="true">→</span> Add to Home Screen to install
      </span>
    );
  }

  return null;
}
