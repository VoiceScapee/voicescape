"use client";

import { useState } from "react";

/**
 * Share buttons for blockpages — X, Facebook, and copy link.
 * Simple URL-based sharing, no API keys needed.
 */
export function ShareButtons({ username }: { username: string }) {
  const [copied, setCopied] = useState(false);

  const getUrl = () => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/${username}`;
  };

  const shareText = `Check out ${username}'s blockpage on Voicescape`;

  const shareX = () => {
    const url = encodeURIComponent(getUrl());
    const text = encodeURIComponent(shareText);
    window.open(`https://twitter.com/intent/tweet?url=${url}&text=${text}`, "_blank", "width=550,height=420");
  };

  const shareFacebook = () => {
    const url = encodeURIComponent(getUrl());
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${url}`, "_blank", "width=550,height=420");
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(getUrl());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const input = document.createElement("input");
      input.value = getUrl();
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
