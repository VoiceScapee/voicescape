"use client";

/**
 * Branded 404 — a mistyped blockpage URL used to land on Next.js's default
 * dead-end page. Now every lost visitor gets a path forward: Explore,
 * Home, or (when signed in) their own blockpage.
 */
import Link from "next/link";
import { useWallet } from "@/lib/wallet";
import { deriveUsername, getVanityName } from "@/lib/identity";

export default function NotFound() {
  let account: string | null = null;
  try {
    account = useWallet().account;
  } catch {
    account = null;
  }
  const myUsername = account ? (getVanityName(account) ?? deriveUsername(account)) : null;

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "72px 20px", textAlign: "center" }}>
      <div style={{ fontSize: 44, marginBottom: 12 }}>🧭</div>
      <h1 style={{ margin: "0 0 8px" }}>This page doesn&apos;t exist</h1>
      <p className="th-muted" style={{ marginTop: 0 }}>
        The link might be mistyped, or the blockpage moved. Here&apos;s where
        you can go instead:
      </p>
      <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 20, flexWrap: "wrap" }}>
        <Link href="/explore" className="vs-btn vs-btn-primary">
          Explore blockpages
        </Link>
        <Link href="/" className="vs-btn vs-btn-ghost">
          ← Home
        </Link>
        {myUsername && (
          <Link href={`/${myUsername}`} className="vs-btn vs-btn-ghost">
            My blockpage
          </Link>
        )}
      </div>
    </div>
  );
}
