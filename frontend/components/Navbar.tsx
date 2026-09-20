"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Logo from "./Logo";
import InstallAppButton from "./InstallAppButton";
import { LanguageSelector } from "./LanguageSelector";
import { T } from "./T";
import NavDropdown from "./NavDropdown";
import type { NavDropdownItem } from "./NavDropdown";
import NetworkPulse from "./NetworkPulse";

interface NavbarProps {
  right?: React.ReactNode;
  /**
   * Hide the logo link (Brandon 2026-09-15): the landing page shows the
   * logo big in its hero, so the navbar's copy is redundant there.
   * Every other destination stays exactly as-is.
   */
  hideLogo?: boolean;
}

/**
 * Nav groups, defined once and rendered twice: as click-to-toggle
 * dropdowns on desktop, and as flat labelled sections inside the single
 * mobile menu. Destinations stay identical in both presentations.
 */
const LEARN_ITEMS: NavDropdownItem[] = [
  { href: "/new-to-web3", label: <T k="nav.newToWeb3" /> },
  { href: "/mining-depin", label: <T k="nav.miningDePIN" /> },
  // Legal doc titles stay untranslated: the English versions govern.
  { href: "/terms", label: <>Terms</> },
  { href: "/privacy", label: <>Privacy</> },
  { href: "/dmca", label: <>Copyright</> },
  { href: "/treasury", label: <>Treasury</> },
];

const COMMUNITY_ITEMS: NavDropdownItem[] = [
  { href: "/forum", label: <T k="nav.townHall" /> },
  { href: "/explore", label: <>Explore</> },
  { href: "/marketplace", label: <>Marketplace</> },
  { href: "/fundraiser", label: <T k="nav.fundraiser" /> },
  { href: "/leaderboard", label: <T k="nav.leaderboard" /> },
  { href: "/following", label: <T k="nav.following" /> },
];

// Phase 1.3 (Brandon 2026-09-19): the builder/agents links move into their
// own Create dropdown so the desktop nav never wraps and the mobile menu
// stays scannable.
const CREATE_ITEMS: NavDropdownItem[] = [
  { href: "/builder", label: <T k="nav.builder" /> },
  { href: "/agents", label: <T k="nav.agents" /> },
];

const SUPPORT_HREF = "https://discord.gg/2KGzPduUN5";

export default function Navbar({ right, hideLogo = false }: NavbarProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLElement>(null);

  // The mobile menu closes on outside tap or Escape, same as NavDropdown.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open ]);

  const close = () => setOpen(false);

  return (
    <header
      ref={rootRef}
      // No banner bar behind the logo (Brandon 2026-09-13): the header is
      // transparent so just the logo and nav float over the page.
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
      }}
    >
      <nav
        className="vs-nav"
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          padding: "12px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          // Anchor for the mobile menu panel.
          position: "relative",
        }}
      >
        {hideLogo ? (
          // Landing page: the hero carries the logo, so keep an invisible
          // spacer here to hold the row's balance (burger stays right).
          <span aria-hidden="true" style={{ flex: "1 1 200px", minWidth: 0 }} />
        ) : (
          <Link
            href="/"
            style={{
              textDecoration: "none",
              display: "inline-flex",
              padding: "4px 0 4px 10px",
              // Let the logo stretch across the row's free space (Brandon
              // 2026-09-13); capped so it never crowds the nav buttons.
              flex: "1 1 200px",
              minWidth: 160,
              maxWidth: 320,
            }}
            aria-label="Voicescape home"
          >
            <Logo size={44} fluid />
          </Link>
        )}
        <button
          type="button"
          className="vs-btn vs-btn-ghost vs-nav-burger"
          aria-expanded={open}
          aria-label="Menu"
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden="true">{open ? "✕" : "☰"}</span>
        </button>
        {/* Global network pulse: the dapp breathing with Hedera mainnet. */}
        <NetworkPulse />
        <div className={`vs-nav-items${open ? " vs-nav-open" : ""}`}>
          {/* Desktop: grouped dropdowns. Mobile: flat sections below. */}
          <div className="vs-nav-desktop-only">
            <NavDropdown label={<T k="nav.create" />} items={CREATE_ITEMS} />
          </div>
          <div className="vs-nav-desktop-only">
            <NavDropdown label={<T k="nav.learn" />} items={LEARN_ITEMS} />
          </div>
          <div className="vs-nav-desktop-only">
            <NavDropdown label={<T k="nav.community" />} items={COMMUNITY_ITEMS} />
          </div>
          <div className="vs-nav-mobile-only">
            <p className="vs-nav-group-label">
              <T k="nav.create" />
            </p>
            {CREATE_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="vs-btn vs-btn-ghost vs-nav-link"
                onClick={close}
              >
                {item.label}
              </Link>
            ))}
            <p className="vs-nav-group-label">
              <T k="nav.learn" />
            </p>
            {LEARN_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="vs-btn vs-btn-ghost vs-nav-link"
                onClick={close}
              >
                {item.label}
              </Link>
            ))}
            <p className="vs-nav-group-label">
              <T k="nav.community" />
            </p>
            {COMMUNITY_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="vs-btn vs-btn-ghost vs-nav-link"
                onClick={close}
              >
                {item.label}
              </Link>
            ))}
          </div>
          <a
            href={SUPPORT_HREF}
            target="_blank"
            rel="noopener noreferrer"
            className="vs-btn vs-btn-ghost vs-nav-link"
            title="Customer support on Discord"
            onClick={close}
          >
            <T k="nav.support" />
          </a>
          <InstallAppButton />
          <LanguageSelector />
          {right}
        </div>
      </nav>
    </header>
  );
}
