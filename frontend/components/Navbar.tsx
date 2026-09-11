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
        background: "rgba(6,6,14,0.72)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        borderBottom: "1px solid var(--vs-border)",
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
        <Link href="/" style={{ textDecoration: "none" }} aria-label="Voicescape home">
          <Logo size={30} />
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
          <InstallAppButton />
          <LanguageSelector />
          {right}
        </div>
      </nav>
    </header>
  );
}
