"use client";

import { useState } from "react";
import {
  buildBadgesShareText,
  buildFacebookShareUrl,
  buildPageShareUrl,
  buildXShareUrl,
  type ShareableBadge,
} from "@/lib/share";

/**
 * Share affordance for earned badges.
 *
 * - On phones (navigator.share available): the native share sheet — one tap
 *   opens the OS sheet with Facebook, X, WhatsApp, SMS, and every other app.
 * - Everywhere: direct X / Facebook share links + copy link as fallback.
 *
 * The shared URL is the page URL with ?ref=<username>, same as page shares —
 * the page owner earns referral credit when someone joins through the link.
 * Only real earned badges are ever shared (the badges prop comes from the
 * badges API, never invented client-side).
 */
export function BadgeShareButtons({
  username,
  badges,
}: {
  username: string;
  badges: ShareableBadge[];
}) {
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);

  if (!badges || badges.length === 0) return null;

  const getPageUrl = () => {
    if (typeof window === "undefined") return "";
    return buildPageShareUrl(window.location.origin, username);
  };

  const getText = () => buildBadgesShareText(badges, username);

  const canNativeShare =
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function";

  const nativeShare = async () => {
    try {
      await navigator.share({
        title: `${username}'s Voicescape badges`,
        text: getText(),
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
    openSharePopup(buildXShareUrl(getPageUrl(), getText()));
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
    <div style={{ display: "flex", gap: 8, justifyContent: "center", margin: "12px 0", flexWrap: "wrap" }}>
      {canNativeShare && (
        <button type="button" onClick={nativeShare} style={btnStyle} aria-label="Share badges">
          {shared ? "✓ Shared!" : "🏅 Share badges"}
        </button>
      )}
      <button type="button" onClick={shareX} style={btnStyle} aria-label="Share badges on X">
        𝕏 Share
      </button>
      <button type="button" onClick={shareFacebook} style={btnStyle} aria-label="Share badges on Facebook">
        f Share
      </button>
      <button type="button" onClick={copyLink} style={btnStyle} aria-label="Copy badge link">
        {copied ? "✓ Copied!" : "🔗 Copy link"}
      </button>
    </div>
  );
}
