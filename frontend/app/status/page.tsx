import type { Metadata } from "next";
import ExternalLink from "@/components/ExternalLink";

export const metadata: Metadata = {
  title: "Status — Voicescape",
  description:
    "Live operational status of Voicescape: Hedera mirror node, on-chain contracts, and this app — checked fresh on every load, nothing cached as 'fine'.",
};

/** Never cache: every load re-checks the real world. */
export const dynamic = "force-dynamic";

const MIRROR = "https://mainnet.mirrornode.hedera.com/api/v1";
const REGISTRY_ID = "0.0.10854058";
const TIPS_ID = "0.0.10854060";
const TIMEOUT_MS = 8000;

type CheckStatus = "ok" | "degraded" | "offline";

interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  ms: number;
  link?: string;
}

async function timedFetch(url: string): Promise<{ ok: boolean; ms: number; json: any }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    const ms = Date.now() - start;
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, ms, json };
  } catch {
    return { ok: false, ms: Date.now() - start, json: null };
  } finally {
    clearTimeout(timer);
  }
}

async function checkMirror(): Promise<Check> {
  const r = await timedFetch(`${MIRROR}/transactions?limit=1&order=desc`);
  if (!r.ok)
    return {
      name: "Hedera mirror node",
      status: "offline",
      detail: "Mirror node unreachable — chain reads are down.",
      ms: r.ms,
      link: "https://status.hedera.com",
    };
  return {
    name: "Hedera mirror node",
    status: r.ms > 4000 ? "degraded" : "ok",
    detail:
      r.ms > 4000
        ? `Responding but slow (${r.ms} ms) — reads may lag.`
        : `Responding normally (${r.ms} ms).`,
    ms: r.ms,
  };
}

async function checkContract(id: string, label: string): Promise<Check> {
  const r = await timedFetch(`${MIRROR}/accounts/${id}`);
  if (!r.ok)
    return {
      name: `${label} contract (${id})`,
      status: "offline",
      detail: "Could not read the contract account — treating as unknown, not fine.",
      ms: r.ms,
      link: `https://hashscan.io/mainnet/contract/${id}`,
    };
  const deleted = r.json?.deleted === true;
  if (deleted)
    return {
      name: `${label} contract (${id})`,
      status: "offline",
      detail: "Contract account is marked deleted on-chain.",
      ms: r.ms,
      link: `https://hashscan.io/mainnet/contract/${id}`,
    };
  // Recent activity: any transaction touching the contract in the last 24h.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const act = await timedFetch(
    `${MIRROR}/transactions?account.id=${id}&timestamp=gte:${since}&limit=1&order=desc`,
  );
  const active = act.ok && Array.isArray(act.json?.transactions) && act.json.transactions.length > 0;
  return {
    name: `${label} contract (${id})`,
    status: "ok",
    detail: active
      ? "Live on mainnet — transacted in the last 24 hours."
      : "Live on mainnet — no transactions in the last 24 hours (quiet, not broken).",
    ms: r.ms,
    link: `https://hashscan.io/mainnet/contract/${id}`,
  };
}

const card: React.CSSProperties = {
  border: "1px solid var(--vs-border, #2a2a3a)",
  borderRadius: 12,
  padding: "16px 18px",
  marginBottom: 12,
  background: "var(--vs-card, #14141f)",
};
const h2: React.CSSProperties = { fontSize: 19, margin: "0 0 8px" };
const p: React.CSSProperties = { color: "var(--vs-muted)", lineHeight: 1.6, margin: "0 0 8px" };
const mono: React.CSSProperties = { fontFamily: "var(--vs-mono, monospace)", fontSize: 13 };

const DOT: Record<CheckStatus, string> = {
  ok: "#3ddc84",
  degraded: "#f5a623",
  offline: "#ff5a5a",
};
const LABEL: Record<CheckStatus, string> = {
  ok: "Operational",
  degraded: "Degraded",
  offline: "Offline",
};

export default async function StatusPage() {
  const checkedAt = new Date();
  const [mirror, registry, tips] = await Promise.all([
    checkMirror(),
    checkContract(REGISTRY_ID, "Registry"),
    checkContract(TIPS_ID, "Tips"),
  ]);
  const appCheck: Check = {
    name: "Voicescape app (this page)",
    status: "ok",
    detail: "This page rendered server-side just now — the app tier is up.",
    ms: 0,
    link: "https://voicescape.vercel.app",
  };
  const checks = [appCheck, mirror, registry, tips];
  const worst: CheckStatus = checks.some((c) => c.status === "offline")
    ? "offline"
    : checks.some((c) => c.status === "degraded")
      ? "degraded"
      : "ok";
  const banner =
    worst === "ok"
      ? "All systems operational"
      : worst === "degraded"
        ? "Degraded — some checks are slow"
        : "Outage — one or more checks failing";

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "32px 20px 64px" }}>
      <h1 style={{ fontSize: 28, margin: "0 0 8px" }}>Status</h1>
      <p style={{ ...p, marginBottom: 24 }}>
        Checked live on every page load — nothing here is cached as
        &quot;fine&quot;. Each check below hit the real service seconds ago.
      </p>

      <div
        style={{
          ...card,
          borderLeft: `4px solid ${DOT[worst]}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: DOT[worst],
              display: "inline-block",
            }}
          />
          <strong style={{ fontSize: 17 }}>{banner}</strong>
        </div>
        <p style={{ ...p, margin: "8px 0 0", fontSize: 13 }}>
          Checked{" "}
          <span style={mono}>
            {checkedAt.toLocaleString("en-US", { timeZone: "America/New_York" })} ET
          </span>
        </p>
      </div>

      {checks.map((c) => (
        <div key={c.name} style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: DOT[c.status],
                display: "inline-block",
                flexShrink: 0,
              }}
            />
            <h2 style={{ ...h2, margin: 0, fontSize: 16 }}>{c.name}</h2>
            <span style={{ ...mono, color: DOT[c.status], marginLeft: "auto" }}>
              {LABEL[c.status]}
            </span>
          </div>
          <p style={{ ...p, margin: 0, fontSize: 14 }}>{c.detail}</p>
          <p style={{ ...p, margin: "6px 0 0", fontSize: 12 }}>
            {c.ms > 0 && (
              <span style={mono}>answered in {c.ms} ms · </span>
            )}
            {c.link && (
              <ExternalLink href={c.link}>verify independently</ExternalLink>
            )}
          </p>
        </div>
      ))}

      <p style={{ ...p, fontSize: 13, marginTop: 24 }}>
        Something wrong that this page doesn&apos;t show? See{" "}
        <a href="/trust" style={{ color: "var(--vs-violet)" }}>
          /trust
        </a>{" "}
        for how to verify the contracts yourself, or report it via{" "}
        <span style={mono}>SECURITY.md</span> in the repo.
      </p>
    </main>
  );
}
