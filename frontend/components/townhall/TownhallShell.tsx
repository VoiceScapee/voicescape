"use client";

/**
 * Town Hall chrome: sticky nav (Forum / Chat / Events / Polls /
 * Marketplace), wallet connect, and the posting-identity bar.
 */
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Navbar from "@/components/Navbar";
import { WalletConnect } from "@/components/WalletConnect";
import { useWriteGate } from "./useTownhall";

const NAV: { href: string; label: string }[] = [
  { href: "/forum", label: "Forum" },
  { href: "/chat", label: "Chat" },
  { href: "/events", label: "Events" },
  { href: "/polls", label: "Polls" },
  { href: "/marketplace", label: "Marketplace" },
];

function IdentityBar() {
  const { username, loaded, setUsername, isAuthenticated, sessionReady } = useWriteGate();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);

  if (!loaded || !sessionReady) return null;

  const save = () => {
    if (draft.trim()) setUsername(draft);
    setEditing(false);
    setDraft("");
  };

  return (
    <div className="th-identity" aria-live="polite">
      {!isAuthenticated ? (
        <span>
          Sign in with your wallet (top right) to post in the Town Hall.
        </span>
      ) : username ? (
        <>
          <span>
            Posting as{" "}
            <Link href={`/${username}`} className="th-identity-name">
              @{username}
            </Link>
          </span>
          <button
            type="button"
            className="th-identity-link"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "cancel" : "switch"}
          </button>
        </>
      ) : (
        <span>
          Set your page username to post —{" "}
          <Link href="/builder" className="th-identity-link">
            no page yet? build one
          </Link>
        </span>
      )}
      {isAuthenticated && (!username || editing) && (
        <span className="th-identity-form">
          <input
            className="vs-input th-identity-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="your page username"
            aria-label="Your page username"
            autoCapitalize="none"
            autoCorrect="off"
          />
          <button type="button" className="vs-btn vs-btn-primary th-btn-sm" onClick={save}>
            Save
          </button>
        </span>
      )}
    </div>
  );
}

export default function TownhallShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="th-shell">
      <Navbar
        right={
          <>
            <nav className="th-nav" aria-label="Town Hall">
              {NAV.map((n) => {
                const active =
                  pathname === n.href || pathname.startsWith(`${n.href}/`);
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={`th-nav-link${active ? " is-active" : ""}`}
                    aria-current={active ? "page" : undefined}
                  >
                    {n.label}
                  </Link>
                );
              })}
            </nav>
            <WalletConnect />
          </>
        }
      />
      <IdentityBar />
      <main className="th-main">{children}</main>
    </div>
  );
}
