"use client";

import { useState } from "react";
import {
  buildFacebookShareUrl,
  buildPageShareUrl,
  buildShareText,
  buildXShareUrl,
} from "@/lib/share";

/**
 * Share buttons for blockpages.
 *
 * - On phones (navigator.share available): the native share sheet — the
 *   proven mobile pattern. One tap opens the OS sheet with Facebook, X,
 *   WhatsApp, SMS, and every other app on the device.
 * - Everywhere: direct X / Facebook share links + copy link as fallback.
 *
 * Every shared URL carries ?ref=<username> so the sharer earns referral
 * credit when someone joins Voicescape through the link.
 */
export function ShareButtons({ username }: { username: string }) {
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);

  const getPageUrl = () => {
    if (typeof window === "undefined") return "";
    return buildPageShareUrl(window.location.origin, username);
  };

  const canNativeShare =
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function";

  const nativeShare = async () => {
    try {
      await navigator.share({
        title: `${username} on Voicescape`,
        text: buildShareText(username),
        url: getPageUrl(),
      });
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    } catch {
      // User dismissed the sheet — not an error.
    }
  };

  const openSharePopup = (url: string) => {
    window.open(url, "_blank", "noopener,width=550,height=420");
  };

  const shareX = () => {
    openSharePopup(buildXShareUrl(getPageUrl(), buildShareText(username)));
  };

  const shareFacebook = () => {
    openSharePopup(buildFacebookShareUrl(getPageUrl()));
  };

  const copyLink = async () => {
    const link = getPageUrl();
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const input = document.createElement("input");
      input.value = link;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const btnStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 16px",
    borderRadius: 20,
    border: "1px solid var(--vs-border)",
    background: "var(--vs-card)",
    color: "var(--vs-text)",
    fontSize: 13,
    cursor: "pointer",
  };

  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "center", margin: "16px 0", flexWrap: "wrap" }}>
      {canNativeShare && (
        <button type="button" onClick={nativeShare} style={btnStyle} aria-label="Share">
          {shared ? "✓ Shared!" : "📤 Share"}
        </button>
      )}
      <button type="button" onClick={shareX} style={btnStyle} aria-label="Share on X">
        𝕏 Share
      </button>
      <button type="button" onClick={shareFacebook} style={btnStyle} aria-label="Share on Facebook">
        f Share
      </button>
      <button type="button" onClick={copyLink} style={btnStyle} aria-label="Copy link">
        {copied ? "✓ Copied!" : "🔗 Copy link"}
      </button>
    </div>
  );
}
