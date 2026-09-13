import Link from "next/link";
import Logo from "./Logo";
import InstallAppButton from "./InstallAppButton";
import { LanguageSelector } from "./LanguageSelector";
import { T } from "./T";

interface NavbarProps {
  right?: React.ReactNode;
}

export default function Navbar({ right }: NavbarProps) {
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        background: "rgba(9,11,18,0.82)",
        backdropFilter: "blur(18px) saturate(140%)",
        WebkitBackdropFilter: "blur(18px) saturate(140%)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
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
          style={{ textDecoration: "none", display: "inline-flex", padding: "4px 0 4px 10px" }}
          aria-label="Voicescape home"
        >
          <Logo size={40} />
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
          <Link
            href="/new-to-web3"
            className="vs-btn vs-btn-ghost"
            style={{ padding: "8px 20px", fontSize: 14 }}
          >
            <T k="nav.newToWeb3" />
          </Link>
          <Link
            href="/mining-depin"
            className="vs-btn vs-btn-ghost"
            style={{ padding: "8px 20px", fontSize: 14 }}
          >
            <T k="nav.miningDePIN" />
          </Link>
          <Link
            href="/forum"
            className="vs-btn vs-btn-ghost"
            style={{ padding: "8px 20px", fontSize: 14 }}
          >
            <T k="nav.townHall" />
          </Link>
          <Link
            href="/builder"
            className="vs-btn vs-btn-ghost"
            style={{ padding: "8px 20px", fontSize: 14 }}
          >
            <T k="nav.builder" />
          </Link>
          <Link
            href="/explore"
            className="vs-btn vs-btn-ghost"
            style={{ padding: "8px 20px", fontSize: 14 }}
          >
            Explore
          </Link>
          <Link
            href="/fundraiser"
            className="vs-btn vs-btn-ghost"
            style={{ padding: "8px 20px", fontSize: 14 }}
          >
            <T k="nav.fundraiser" />
          </Link>
          <Link
            href="/leaderboard"
            className="vs-btn vs-btn-ghost"
            style={{ padding: "8px 20px", fontSize: 14 }}
          >
            <T k="nav.leaderboard" />
          </Link>
          <Link
            href="/following"
            className="vs-btn vs-btn-ghost"
            style={{ padding: "8px 20px", fontSize: 14 }}
          >
            <T k="nav.following" />
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
