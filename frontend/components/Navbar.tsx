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
 * dropdowns on desktop, and as collapsible accordions inside the single
 * mobile menu. Destinations stay identical in both presentations.
 */
const LEARN_ITEMS: NavDropdownItem[] = [
  { href: "/new-to-web3", label: <T k="nav.newToWeb3" /> },
  { href: "/mining-depin", label: <T k="nav.miningDePIN" /> },
  // Legal doc titles stay untranslated: the English versions govern.
  { href: "/terms", label: <>Terms</> },
  { href: "/privacy", label: <>Privacy</> },
  { href: "/dmca", label: <>Copyright</> },
];

const COMMUNITY_ITEMS: NavDropdownItem[] = [
  { href: "/forum", label: <T k="nav.townHall" /> },
  { href: "/forum/agent-workshop", label: <>Agent Workshop</> },
  { href: "/intros", label: <>Agent Intros</> },
  { href: "/agents/start", label: <>For Agents</> },
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
  // Embeddable tip button for creators' external sites.
  { href: "/embed", label: <>Embed a tip button</> },
];

const SUPPORT_HREF = "https://discord.gg/2KGzPduUN5";

/**
 * Mobile accordion group (Brandon 2026-10-01): the flat 17-row mobile menu
 * was unreadable, so the three nav groups collapse into accordions — one
 * tap to scan the groups, one more to pick a destination. Only one group
 * opens at a time; headers stay 52px tall for thumbs.
 */
function MobileNavGroup({
  id,
  label,
  items,
  open,
  onToggle,
  onNavigate,
}: {
  id: string;
  label: React.ReactNode;
  items: NavDropdownItem[];
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  const bodyId = `vs-mobile-nav-${id}`;
  return (
    <div className="vs-nav-accordion">
      <button
        type="button"
        className="vs-nav-accordion-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <span className="vs-nav-accordion-label">{label}</span>
        <span
          aria-hidden="true"
          className={`vs-nav-accordion-chevron${open ? " is-open" : ""}`}
        >
          ▾
        </span>
      </button>
      {open && (
        <div id={bodyId} className="vs-nav-accordion-body">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="vs-btn vs-btn-ghost vs-nav-link"
              onClick={onNavigate}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Navbar({ right, hideLogo = false }: NavbarProps) {
  const [open, setOpen] = useState(false);
  // Which mobile accordion group is expanded (null = all collapsed).
  const [openGroup, setOpenGroup] = useState<string | null>("create");
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

  const close = () => {
    setOpen(false);
    // The next open starts from the same predictable place.
    setOpenGroup("create");
  };

  const toggleMenu = () => {
    setOpen((v) => {
      if (!v) setOpenGroup("create");
      return !v;
    });
  };

  const toggleGroup = (id: string) =>
    setOpenGroup((g) => (g === id ? null : id));

  return (
    <header
      ref={rootRef}
      // No banner bar behind the logo (Brandon 2026-09-13): the header is
      // transparent so just the logo and nav float over the page. Exception
      // (Brandon 2026-10-01): while the mobile menu is open the header goes
      // solid — page content scrolling through behind the open menu looked
      // broken. Desktop keeps the floating look.
      className={open ? "vs-nav-menu-open" : undefined}
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        // iOS PWA (viewport-fit=cover): keep the chrome below the notch /
        // Dynamic Island. Zero on devices without a safe area.
        paddingTop: "env(safe-area-inset-top)",
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
              // minWidth 120 (was 160): the 360px row (logo + pulse + burger)
              // otherwise overflows — the pulse "ago" label hides <480px too.
              flex: "1 1 200px",
              minWidth: 120,
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
          onClick={toggleMenu}
        >
          <span aria-hidden="true">{open ? "✕" : "☰"}</span>
        </button>
        {/* Global network pulse: the dapp breathing with Hedera mainnet. */}
        <NetworkPulse />
        <div className={`vs-nav-items${open ? " vs-nav-open" : ""}`}>
          {/* Desktop: grouped dropdowns. Mobile: accordions below. */}
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
            {/* Mobile: the same three groups as desktop, collapsed into
                accordions so the menu scans in three rows, not seventeen. */}
            <MobileNavGroup
              id="create"
              label={<T k="nav.create" />}
              items={CREATE_ITEMS}
              open={openGroup === "create"}
              onToggle={() => toggleGroup("create")}
              onNavigate={close}
            />
            <MobileNavGroup
              id="learn"
              label={<T k="nav.learn" />}
              items={LEARN_ITEMS}
              open={openGroup === "learn"}
              onToggle={() => toggleGroup("learn")}
              onNavigate={close}
            />
            <MobileNavGroup
              id="community"
              label={<T k="nav.community" />}
              items={COMMUNITY_ITEMS}
              open={openGroup === "community"}
              onToggle={() => toggleGroup("community")}
              onNavigate={close}
            />
            <a
              href={SUPPORT_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="vs-btn vs-btn-ghost vs-nav-link vs-nav-support-row"
              title="Customer support on Discord"
              onClick={close}
            >
              <T k="nav.support" />
              <span aria-hidden="true" className="vs-nav-external">
                ↗
              </span>
            </a>
            {/* Account + tools footer: wallet controls and app settings get
                their own separated section instead of floating loose. */}
            <div className="vs-nav-mobile-footer">
              {right ? (
                <div className="vs-nav-mobile-account">{right}</div>
              ) : null}
              <div className="vs-nav-mobile-tools">
                <InstallAppButton />
                <LanguageSelector />
              </div>
            </div>
          </div>
          {/* Desktop row: support, install, language, wallet. display:contents
              keeps them as direct flex items of the nav row. */}
          <div className="vs-nav-desktop-only vs-nav-desktop-tools">
            <a
              href={SUPPORT_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="vs-btn vs-btn-ghost vs-nav-link"
              title="Customer support on Discord"
            >
              <T k="nav.support" />
            </a>
            <InstallAppButton />
            <LanguageSelector />
            {right}
          </div>
        </div>
      </nav>
    </header>
  );
}
