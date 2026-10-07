"use client";

import { useState } from "react";

/** Small copy-to-clipboard button for endpoint URLs and config snippets. */
export default function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (permissions, non-secure context) —
      // select-and-copy fallback via a temporary textarea.
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${label}`}
      style={{
        flexShrink: 0,
        fontSize: 12.5,
        fontWeight: 700,
        padding: "10px 16px",
        minHeight: 44,
        borderRadius: 8,
        border: "1px solid rgba(130, 89, 239, 0.4)",
        background: copied ? "rgba(130, 89, 239, 0.25)" : "transparent",
        color: "var(--vs-text)",
        cursor: "pointer",
      }}
    >
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}
