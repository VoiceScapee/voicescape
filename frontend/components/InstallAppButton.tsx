"use client";

/**
 * InstallAppButton — shows a native "Install app" button when the browser
 * fires `beforeinstallprompt` (Chrome/Edge on desktop + Android).
 * Firefox never fires that event, so Firefox users get a manual install
 * hint instead of nothing. Hidden when the app is already installed
 * (standalone display mode).
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
  const [firefoxHint, setFirefoxHint] = useState(false);
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
    // Firefox never fires beforeinstallprompt — after a grace period with no
    // prompt event, offer Firefox users a manual install hint instead of
    // rendering nothing.
    const isFirefox =
      /firefox/i.test(navigator.userAgent) &&
      !/seamonkey/i.test(navigator.userAgent);
    const hintTimer = window.setTimeout(() => {
      if (isFirefox) setFirefoxHint(true);
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
        style={{ padding: "8px 20px", fontSize: 14 }}
        aria-label="Install the Voicescape app"
      >
        ⬇ Install app
      </button>
    );
  }

  if (firefoxHint) {
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
          style={{ padding: "8px 20px", fontSize: 14 }}
          aria-label="How to install the Voicescape app in Firefox"
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
            In Firefox: open the page menu (☰) and choose “Install”, or look for
            the install icon in the address bar.
          </p>
        )}
      </div>
    );
  }

  return null;
}
