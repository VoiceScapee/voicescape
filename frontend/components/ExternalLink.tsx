"use client";

import type { AnchorHTMLAttributes, MouseEvent } from "react";

type ExternalLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
};

/**
 * Anchor for external sites.
 *
 * In-app browsers (e.g. HashPack's dApp browser) silently swallow new-tab
 * opens — a plain `target="_blank"` tap does nothing there. On a plain
 * left-click this tries `window.open` first; when the browser reports the
 * open as blocked (returns null), it falls back to same-tab navigation so
 * the tap always goes somewhere. Modifier/middle clicks are left to the
 * browser so power-user behavior is unchanged.
 */
export default function ExternalLink({
  href,
  onClick,
  ...rest
}: ExternalLinkProps) {
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    // Let the browser handle middle-clicks and modifier-clicks natively.
    if (
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }
    e.preventDefault();
    let opened: Window | null = null;
    try {
      opened = window.open(href, "_blank", "noopener");
    } catch {
      opened = null;
    }
    if (!opened) {
      // New-tab open was swallowed (in-app browser): navigate in place.
      window.location.href = href;
    }
  };
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      {...rest}
    />
  );
}
