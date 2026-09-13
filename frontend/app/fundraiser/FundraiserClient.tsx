"use client";

/**
 * <FundraiserClient> — the fundraiser board.
 *
 * Lists every creator funding goal as a campaign card: title, creator,
 * goal, on-chain raised total, and a progress bar. Donating is an ordinary
 * on-chain tip to the creator's blockpage (the proven 98/2 Tips contract
 * path) — the board aggregates, it never touches funds.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { WalletConnect } from "@/components/WalletConnect";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useWallet } from "@/lib/wallet";
import { deriveUsername } from "@/lib/identity";

interface FundraiserEntry {
  username: string;
  title: string | null;
  targetHbar: number;
  owner: string;
  raisedHbar: number;
  createdAt: string;
  updatedAt: string;
}

function fmtHbar(n: number): string {
  return n >= 100 ? Math.round(n).toString() : n.toFixed(n >= 1 ? 2 : 4);
}

function FundraiserCard({ f }: { f: FundraiserEntry }) {
  const { t } = useLanguage();
  const pct = f.targetHbar > 0 ? Math.max(0, Math.min(100, (f.raisedHbar / f.targetHbar) * 100)) : 0;
  return (
    <div
      className="vs-glass"
      style={{ padding: 20, borderRadius: 14, display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>
          {f.title || t("fundraiser.untitled")}
        </div>
        <Link
          href={`/${f.username}`}
          className="vs-mono"
          style={{ fontSize: 13, color: "var(--vs-muted)", textDecoration: "none" }}
        >
          @{f.username}
        </Link>
      </div>

      <div>
        <div
          style={{
            height: 10,
            borderRadius: 999,
            background: "rgba(255,255,255,0.08)",
            overflow: "hidden",
            marginBottom: 8,
          }}
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("fundraiser.progressLabel")}
        >
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              borderRadius: 999,
              background: "var(--vs-gradient)",
              transition: "width 0.6s ease",
            }}
          />
        </div>
        <div style={{ fontSize: 14, color: "var(--vs-muted)" }}>
          {t("fundraiser.progress")
            .replace("{raised}", fmtHbar(f.raisedHbar))
            .replace("{target}", fmtHbar(f.targetHbar))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: "auto", flexWrap: "wrap" }}>
        <Link
          href={`/${f.username}?tip=1`}
          className="vs-btn vs-btn-primary"
          style={{ padding: "10px 22px", fontSize: 14, textDecoration: "none" }}
        >
          {t("fundraiser.donate")}
        </Link>
        <Link
          href={`/${f.username}`}
          className="vs-btn vs-btn-ghost"
          style={{ padding: "10px 22px", fontSize: 14, textDecoration: "none" }}
        >
          {t("fundraiser.viewBlockpage")}
        </Link>
      </div>
    </div>
  );
}

export default function FundraiserClient() {
  const { t } = useLanguage();
  const { account } = useWallet();
  const [fundraisers, setFundraisers] = useState<FundraiserEntry[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/fundraisers", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setFundraisers(Array.isArray(d.fundraisers) ? d.fundraisers : []);
      })
      .catch(() => {
        setError(true);
        setFundraisers([]);
      });
  }, []);

  const myUsername = useMemo(() => (account ? deriveUsername(account) : null), [account]);
  // "Start a fundraiser" deep-links the signed-in owner straight to the
  // funding-goal setter on their blockpage (?goal=1 scrolls to the form).
  const startHref = myUsername ? `/${myUsername}?goal=1` : "/builder";

  return (
    <main style={{ minHeight: "100vh", background: "var(--vs-bg)" }}>
      <Navbar right={<WalletConnect />} />

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "32px 18px 72px" }}>
        <h1 style={{ fontSize: "clamp(1.8rem, 5vw, 2.6rem)", marginBottom: 8 }}>
          {t("fundraiser.title")}
        </h1>
        <p style={{ color: "var(--vs-muted)", marginBottom: 12, lineHeight: 1.6, maxWidth: 640 }}>
          {t("fundraiser.subtitle")}
        </p>
        <p style={{ color: "var(--vs-muted)", marginBottom: 28, lineHeight: 1.6, maxWidth: 640, fontSize: 13 }}>
          {t("fundraiser.rule")}
        </p>

        <div style={{ marginBottom: 32 }}>
          <Link
            href={startHref}
            className="vs-btn vs-btn-primary"
            style={{ padding: "12px 28px", fontSize: 15, textDecoration: "none" }}
          >
            {t("fundraiser.start")}
          </Link>
        </div>

        {error && <p style={{ color: "#f87171" }}>{t("fundraiser.error")}</p>}

        {fundraisers === null ? (
          <p style={{ color: "var(--vs-muted)" }}>{t("fundraiser.loading")}</p>
        ) : fundraisers.length === 0 ? (
          <div className="vs-glass" style={{ padding: 28, borderRadius: 14, maxWidth: 640 }}>
            <p style={{ fontWeight: 700, marginBottom: 8 }}>{t("fundraiser.empty")}</p>
            <p style={{ color: "var(--vs-muted)", lineHeight: 1.6, margin: 0 }}>
              {t("fundraiser.emptyBody")}
            </p>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            }}
          >
            {fundraisers.map((f) => (
              <FundraiserCard key={f.username} f={f} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
