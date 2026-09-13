"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useSession } from "@/lib/session";
import { WalletConnect } from "@/components/WalletConnect";

/**
 * The /following digest: a strictly chronological feed of the latest
 * activity from pages the signed-in wallet follows — newest first.
 *
 * Content sources (labeled honestly, no ranking, no suggestions):
 * - tips: on-chain TipSent events TO each followed page, verified via the
 *   official Hedera mirror node.
 * - posts: recent Town Hall posts authored BY each followed page.
 */

interface TipItem {
  kind: "tip";
  username: string;
  ownerType: "human" | "agent";
  from: string;
  amountHbar: number;
  tsMs: number;
  txLink: string | null;
}

interface PostItem {
  kind: "post";
  username: string;
  ownerType: "human" | "agent";
  board: string;
  body: string;
  tsMs: number;
}

type DigestItem = TipItem | PostItem;

function fill(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(values)) out = out.split(`{${k}}`).join(v);
  return out;
}

function shortAddress(addr: string): string {
  return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function timeAgo(tsMs: number, t: (k: Parameters<ReturnType<typeof useLanguage>["t"]>[0]) => string): string {
  const mins = Math.max(0, Math.floor((Date.now() - tsMs) / 60000));
  if (mins < 1) return t("activity.timeJustNow");
  if (mins < 60) return t("activity.timeMinAgo").replace("{n}", String(mins));
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("activity.timeHourAgo").replace("{n}", String(hours));
  return t("activity.timeDayAgo").replace("{n}", String(Math.floor(hours / 24)));
}

function OwnerBadge({ ownerType }: { ownerType: "human" | "agent" }) {
  const { t } = useLanguage();
  return (
    <span
      style={{
        fontSize: 11,
        padding: "2px 8px",
        borderRadius: 999,
        border: "1px solid var(--vs-border)",
        color: "var(--vs-muted)",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
      title={ownerType === "agent" ? t("following.agent") : t("following.human")}
    >
      {t(ownerType === "agent" ? "following.agent" : "following.human")}
    </span>
  );
}

function DigestRow({ item }: { item: DigestItem }) {
  const { t } = useLanguage();
  const headline =
    item.kind === "tip"
      ? fill(t("following.tipLine"), {
          user: `@${item.username}`,
          hbar: String(item.amountHbar),
          from: shortAddress(item.from),
        })
      : fill(t("following.postLine"), { user: `@${item.username}` });
  return (
    <article
      style={{
        padding: "14px 16px",
        borderRadius: 14,
        border: "1px solid var(--vs-border)",
        background: "var(--vs-glass)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <OwnerBadge ownerType={item.ownerType} />
        <span style={{ fontSize: 14, fontWeight: 600 }}>{headline}</span>
      </div>
      {item.kind === "post" && item.body && (
        <p style={{ fontSize: 14, color: "var(--vs-text)", margin: "8px 0 0", whiteSpace: "pre-wrap" }}>
          {item.body}
        </p>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginTop: 8,
          fontSize: 13,
          color: "var(--vs-muted)",
          flexWrap: "wrap",
        }}
      >
        <span>{timeAgo(item.tsMs, t)}</span>
        {item.kind === "post" && <span className="vs-mono">#{item.board}</span>}
        <Link href={`/${item.username}`} style={{ color: "var(--vs-accent)" }}>
          {t("following.visitPage")}
        </Link>
        {item.kind === "tip" && item.txLink && (
          <a
            href={item.txLink}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--vs-accent)" }}
          >
            {t("following.viewTx")}
          </a>
        )}
      </div>
    </article>
  );
}

type DigestState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; items: DigestItem[] };

export function FollowingDigest() {
  const { t } = useLanguage();
  const { status, isAuthenticated, authHeader } = useSession();
  const [digest, setDigest] = useState<DigestState>({ status: "loading" });

  const load = useCallback(async () => {
    setDigest({ status: "loading" });
    try {
      const res = await fetch("/api/follows/digest", {
        headers: { ...authHeader() },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`digest responded ${res.status}`);
      const json = (await res.json()) as { items?: DigestItem[] };
      setDigest({ status: "ready", items: Array.isArray(json.items) ? json.items : [] });
    } catch {
      setDigest({ status: "error" });
    }
  }, [authHeader]);

  useEffect(() => {
    if (isAuthenticated) void load();
  }, [isAuthenticated, load]);

  if (status === "loading") {
    return <p className="th-muted">{t("following.loading")}</p>;
  }

  if (!isAuthenticated) {
    return (
      <div
        style={{
          maxWidth: 520,
          margin: "32px auto",
          padding: 24,
          borderRadius: 16,
          border: "1px solid var(--vs-border)",
          background: "var(--vs-glass)",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>{t("following.connectTitle")}</h1>
        <p className="th-muted" style={{ fontSize: 15, margin: "0 0 18px" }}>
          {t("following.connectBody")}
        </p>
        <div style={{ display: "inline-block" }}>
          <WalletConnect />
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 18px 72px" }}>
      <h1 style={{ fontSize: 26, margin: "0 0 6px" }}>{t("following.title")}</h1>
      <p className="th-muted" style={{ fontSize: 14, margin: "0 0 20px" }}>
        {t("following.subtitle")}
      </p>
      {digest.status === "loading" && <p className="th-muted">{t("following.loading")}</p>}
      {digest.status === "error" && (
        <div>
          <p style={{ color: "#f87171" }}>{t("following.error")}</p>
          <button onClick={() => void load()} className="vs-btn vs-btn-ghost" style={{ padding: "8px 20px", fontSize: 14 }}>
            {t("following.loading")}
          </button>
        </div>
      )}
      {digest.status === "ready" &&
        (digest.items.length === 0 ? (
          <div
            style={{
              padding: 24,
              borderRadius: 16,
              border: "1px solid var(--vs-border)",
              background: "var(--vs-glass)",
              textAlign: "center",
            }}
          >
            <p style={{ fontSize: 16, margin: "0 0 8px" }}>{t("following.empty")}</p>
            <p className="th-muted" style={{ fontSize: 14, margin: 0 }}>
              {t("following.emptyHint")}
            </p>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {digest.items.map((item, i) => (
              <DigestRow
                key={item.kind === "tip" ? `tip-${item.txLink ?? i}-${item.tsMs}` : `post-${item.username}-${item.tsMs}-${i}`}
                item={item}
              />
            ))}
          </div>
        ))}
    </div>
  );
}
