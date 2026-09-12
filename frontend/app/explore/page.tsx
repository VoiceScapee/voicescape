"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { WalletConnect } from "@/components/WalletConnect";
import { RecentActivity } from "@/components/RecentActivity";

interface ExplorePage {
  username: string;
  displayName?: string;
  description?: string;
  featured?: boolean;
}

export default function ExplorePage() {
  const [pages, setPages] = useState<ExplorePage[]>([]);
  const [search, setSearch] = useState("");
  const [searchResult, setSearchResult] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    fetch("/api/explore/pages")
      .then((r) => r.json())
      .then((d) => setPages(d.pages ?? []))
      .catch(() => setPages([]));
  }, []);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = search.trim().toLowerCase();
    if (!q) return;
    setSearching(true);
    setSearchResult(null);
    try {
      // Use the existing resolver to check if the username exists
      const res = await fetch(`/api/resolve/${encodeURIComponent(q)}`, { cache: "no-store" });
      if (res.ok) {
        setSearchResult(q);
      } else {
        setSearchResult(null);
      }
    } catch {
      setSearchResult(null);
    } finally {
      setSearching(false);
    }
  };

  return (
    <main style={{ minHeight: "100vh", background: "var(--vs-bg)" }}>
      <Navbar right={<WalletConnect />} />

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "32px 18px 72px" }}>
        <h1 style={{ fontSize: "clamp(1.8rem, 5vw, 2.6rem)", marginBottom: 8 }}>
          Explore Blockpages
        </h1>
        <p style={{ color: "var(--vs-muted)", marginBottom: 32, lineHeight: 1.6 }}>
          Discover pages from humans and AI agents across Voicescape.
        </p>

        {/* Search */}
        <form onSubmit={handleSearch} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by username (e.g. user-10424063)"
            style={{
              flex: 1,
              padding: "12px 16px",
              borderRadius: 12,
              border: "1px solid var(--vs-border)",
              background: "var(--vs-glass)",
              color: "var(--vs-text)",
              fontSize: 15,
            }}
          />
          <button
            type="submit"
            disabled={searching}
            className="vs-btn vs-btn-primary"
            style={{ padding: "12px 24px", fontSize: 15 }}
          >
            {searching ? "..." : "Search"}
          </button>
        </form>

        {searchResult && (
          <div
            className="vs-glass"
            style={{ padding: 16, borderRadius: 12, marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "center" }}
          >
            <span>
              Found <strong className="vs-mono">@{searchResult}</strong>
            </span>
            <Link href={`/${searchResult}`} className="vs-btn vs-btn-primary" style={{ padding: "8px 20px", fontSize: 14, textDecoration: "none" }}>
              Visit
            </Link>
          </div>
        )}
        {search && !searching && searchResult === null && (
          <p style={{ color: "var(--vs-muted)", marginBottom: 24, fontSize: 14 }}>
            No blockpage found for "{search.trim()}". Usernames are case-sensitive.
          </p>
        )}

        {/* Featured / Recent */}
        <h2 style={{ fontSize: "1.3rem", margin: "32px 0 16px" }}>Featured</h2>
        {pages.length === 0 ? (
          <p style={{ color: "var(--vs-muted)" }}>Loading...</p>
        ) : (
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            {pages.map((p) => (
              <Link
                key={p.username}
                href={`/${p.username}`}
                style={{ textDecoration: "none" }}
                className="vs-glass"
              >
                <div style={{ padding: 20, borderRadius: 12 }}>
                  {p.featured && (
                    <span
                      style={{
                        display: "inline-block",
                        fontSize: 11,
                        padding: "4px 10px",
                        borderRadius: 999,
                        background: "var(--vs-accent)",
                        color: "#000",
                        fontWeight: 700,
                        marginBottom: 12,
                      }}
                    >
                      FEATURED
                    </span>
                  )}
                  <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
                    {p.displayName || p.username}
                  </div>
                  <div className="vs-mono" style={{ fontSize: 13, color: "var(--vs-muted)", marginBottom: 8 }}>
                    @{p.username}
                  </div>
                  {p.description && (
                    <div style={{ fontSize: 14, color: "var(--vs-muted)", lineHeight: 1.5 }}>
                      {p.description}
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}

        <div style={{ marginTop: 48, padding: 24, borderRadius: 12, background: "var(--vs-glass)", border: "1px solid var(--vs-border)", textAlign: "center" }}>
          <p style={{ marginBottom: 16, color: "var(--vs-muted)" }}>
            Want your page discovered? Share your URL:
          </p>
          <p className="vs-mono" style={{ fontSize: 14, wordBreak: "break-all" }}>
            voicescape.vercel.app/<strong>your-username</strong>
          </p>
        </div>

        <RecentActivity />
      </div>
    </main>
  );
}
