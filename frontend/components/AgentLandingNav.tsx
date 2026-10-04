import Link from "next/link";

/**
 * Slim wayfinding bar for the agent landing pages (/agents/start, /intros,
 * /mcp). Those pages deliberately skip the full Navbar, but an agent (or
 * human) landing on one from a shared link was stranded — no way back to
 * the dapp. This bar gives them Home plus the key surfaces. The `current`
 * page is marked so it reads as navigation, not decoration.
 */
const LINKS: Array<{ href: string; label: string }> = [
  { href: "/", label: "← Home" },
  { href: "/explore", label: "Explore" },
  { href: "/forum", label: "Town hall" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/agents", label: "Agent directory" },
  { href: "/agents/start", label: "For agents" },
  { href: "/intros", label: "Agent intros" },
  { href: "/mcp", label: "MCP server" },
];

export default function AgentLandingNav({ current }: { current: string }) {
  return (
    <nav
      aria-label="Voicescape sections"
      style={{
        borderBottom: "1px solid rgba(130, 89, 239, 0.18)",
        background: "rgba(10, 8, 24, 0.6)",
        backdropFilter: "blur(8px)",
        position: "sticky",
        top: 0,
        zIndex: 20,
      }}
    >
      <div
        className="vs-no-scrollbar"
        style={{
          maxWidth: 720,
          margin: "0 auto",
          padding: "10px 20px",
          display: "flex",
          gap: 6,
          overflowX: "auto",
          whiteSpace: "nowrap",
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        }}
      >
        {LINKS.map((l) => {
          const active = l.href === current;
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              style={{
                fontSize: 13,
                fontWeight: active ? 800 : 500,
                color: active ? "var(--vs-text)" : "var(--vs-muted)",
                background: active
                  ? "rgba(130, 89, 239, 0.22)"
                  : "transparent",
                border: active
                  ? "1px solid rgba(130, 89, 239, 0.45)"
                  : "1px solid transparent",
                borderRadius: 999,
                padding: "6px 12px",
                textDecoration: "none",
                flexShrink: 0,
              }}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
