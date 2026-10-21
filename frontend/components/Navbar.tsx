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
  /**
   * Show the Commonworld Atlas Verified badge beside the NetworkPulse
   * heartbeat chip (Brandon 2026-10-21). Homepage only: the navbar row is
   * already tight on phones, so other pages stay exactly as-is.
   */
  atlasBadge?: boolean;
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
  { href: "/console", label: <>Console</> },
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

export default function Navbar({
  right,
  hideLogo = false,
  atlasBadge = false,
}: NavbarProps) {
  const [open, setOpen] = useState(false);
  // Which mobile accordion group is expanded (null = all collapsed).
  const [openGroup, setOpenGroup] = useState<string | null>("create");
  // D4: once the page scrolls, the transparent header gains a translucent
  // solid + blur (vs-nav-scrolled) so content stops sliding visibly
  // through the gaps between the pulse chip, badge, and burger.
  const [scrolled, setScrolled] = useState(false);
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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
      className={
        open ? "vs-nav-menu-open" : scrolled ? "vs-nav-scrolled" : undefined
      }
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
          maxWidth: "var(--vs-reading)",
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          // Padding + gap live in .vs-nav (globals.css) so narrow widths
          // can tighten them (M1/D2).
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
        <span
          className="vs-pulse-badge-wrap"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
          }}
        >
          <NetworkPulse />
          {atlasBadge ? (
            /* Commonworld Atlas Verified badge (dark variant: chrome sits
               on #090b12). Plain SVG, no scripts/cookies/tracking; updates
               with Atlas weekly checks. Card:
               https://commonworld.one/atlas/platforms/voicescape/ */
            <a
              href="https://commonworld.one/atlas/platforms/voicescape/"
              target="_blank"
              rel="noreferrer"
              aria-label="Commonworld Atlas: Verified"
              className="vs-atlas-badge"
              style={{
                display: "inline-flex",
                flexShrink: 0,
                /* M2: 12px vertical padding lifts the 20px artwork to a
                   44px hit area; M1: artwork drops to 16px below 480px
                   via .vs-atlas-badge img in globals.css. */
                padding: "12px 0",
              }}
            >
              <img
                src="https://commonworld.one/atlas/badge/voicescape-dark.svg"
                alt="Commonworld Atlas: Verified"
                height="20"
                style={{ display: "block" }}
              />
            </a>
          ) : null}
        </span>
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
