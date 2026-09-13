import Link from "next/link";
import Logo from "./Logo";
import InstallAppButton from "./InstallAppButton";
import { LanguageSelector } from "./LanguageSelector";
import { T } from "./T";
import NavDropdown from "./NavDropdown";

interface NavbarProps {
  right?: React.ReactNode;
}

export default function Navbar({ right }: NavbarProps) {
  return (
    <header
      // No banner bar behind the logo (Brandon 2026-09-13): the header is
      // transparent so just the logo and nav float over the page.
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
      }}
    >
      <nav
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          padding: "12px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            marginLeft: "auto",
          }}
        >
          <NavDropdown
            label={<T k="nav.learn" />}
            items={[
              { href: "/new-to-web3", label: <T k="nav.newToWeb3" /> },
              { href: "/mining-depin", label: <T k="nav.miningDePIN" /> },
            ]}
          />
          <NavDropdown
            label={<T k="nav.community" />}
            items={[
              { href: "/forum", label: <T k="nav.townHall" /> },
              { href: "/explore", label: <>Explore</> },
              { href: "/fundraiser", label: <T k="nav.fundraiser" /> },
              { href: "/leaderboard", label: <T k="nav.leaderboard" /> },
              { href: "/following", label: <T k="nav.following" /> },
            ]}
          />
          <Link
            href="/builder"
            className="vs-btn vs-btn-ghost"
            style={{ padding: "8px 20px", fontSize: 14 }}
          >
            <T k="nav.builder" />
          </Link>
          <Link
            href="/agents"
            className="vs-btn vs-btn-ghost"
            style={{ padding: "8px 20px", fontSize: 14 }}
          >
            <T k="nav.agents" />
          </Link>
          <a
            href="https://discord.gg/2KGzPduUN5"
            target="_blank"
            rel="noopener noreferrer"
            className="vs-btn vs-btn-ghost"
            style={{ padding: "8px 20px", fontSize: 14, textDecoration: "none" }}
            title="Customer support on Discord"
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
