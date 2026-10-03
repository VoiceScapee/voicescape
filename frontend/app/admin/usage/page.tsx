"use client";

/**
 * Founder-only usage dashboard — /admin/usage.
 *
 * Brandon's internal eyes on real usage: Buddy widget funnel, builder
 * funnel, recent builder preview snapshots (rendered with the same
 * PageRenderer the builder uses — pixel-identical to what the user saw;
 * anonymous, no wallets/IPs/usernames attached), and failure samples.
 * Same founder gate as /admin/errors: GET /api/admin/usage requires a
 * founder wallet session. Nothing on this page is public.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/session";
import { WalletConnect } from "@/components/WalletConnect";
import PageRenderer from "@/components/PageRenderer";
import PreviewErrorBoundary from "@/components/PreviewErrorBoundary";
import { isValidPage, type VoicescapePage } from "@/lib/schema";

interface PreviewSnapshot {
  page: unknown;
  at: number;
}

interface UsageData {
  counts: Record<string, number>;
  previews: PreviewSnapshot[];
  samples: Record<string, { event: string; detail?: string; at: number }[]>;
  day: string;
}

const FUNNELS: { title: string; events: string[] }[] = [
  { title: "Buddy widget", events: ["buddy.open", "buddy.message_sent", "buddy.message_failed", "buddy.build_started"] },
  { title: "Builder", events: ["builder.open", "builder.block_add", "builder.preview", "builder.publish_attempt", "builder.publish_success", "builder.publish_failed"] },
];

function fmtTime(ms: number): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

function SnapshotCard({ snap }: { snap: PreviewSnapshot }) {
  const page = isValidPage(snap.page) ? (snap.page as VoicescapePage) : null;
  const blockCount = page ? page.blocks.length : 0;
  return (
    <div
      style={{
        border: "1px solid rgba(180,92,240,.3)",
        borderRadius: 12,
        overflow: "hidden",
        width: 300,
        background: "#0d0a18",
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.65, padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
        {fmtTime(snap.at)} · {blockCount} blocks
      </div>
      <div style={{ height: 380, overflow: "hidden", pointerEvents: "none" }}>
        {page ? (
          <PreviewErrorBoundary>
            <div style={{ transform: "scale(0.62)", transformOrigin: "top left", width: "161%" }}>
              <PageRenderer page={page} preview />
            </div>
          </PreviewErrorBoundary>
        ) : (
          <div style={{ padding: 16, fontSize: 12, opacity: 0.5 }}>Snapshot failed validation — possible corrupt draft.</div>
        )}
      </div>
    </div>
  );
}

export default function UsageDashboard() {
  const { isAuthenticated } = useSession();
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    void fetch("/api/admin/usage")
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 403 ? "not a founder wallet" : `HTTP ${r.status}`);
        setData(await r.json());
      })
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"));
  }, [isAuthenticated]);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 20px 64px", color: "#f2ecff" }}>
      <div style={{ marginBottom: 16 }}>
        <Link href="/admin/errors" style={{ color: "#b45cf0", fontSize: 13 }}>← Error dashboard</Link>
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>Usage — founder only</h1>
      <p style={{ opacity: 0.65, fontSize: 13, marginBottom: 24 }}>
        Anonymous aggregates. No wallets, IPs, usernames, or message text. {data ? `Day: ${data.day}` : ""}
      </p>

      {!isAuthenticated && (
        <div style={{ marginBottom: 24 }}>
          <p style={{ fontSize: 14, marginBottom: 12 }}>Connect a founder wallet to view.</p>
          <WalletConnect />
        </div>
      )}
      {error && <p style={{ color: "#f87171" }}>{error}</p>}

      {data && (
        <>
          {FUNNELS.map((f) => (
            <section key={f.title} style={{ marginBottom: 28 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>{f.title} — today</h2>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {f.events.map((e) => (
                  <div
                    key={e}
                    style={{
                      border: "1px solid rgba(180,92,240,.3)",
                      borderRadius: 10,
                      padding: "10px 14px",
                      minWidth: 120,
                      background: "rgba(123,63,242,.08)",
                    }}
                  >
                    <div style={{ fontSize: 22, fontWeight: 800 }}>{data.counts[e] ?? 0}</div>
                    <div style={{ fontSize: 11, opacity: 0.7 }}>{e.replace(/^(buddy|builder)\./, "")}</div>
                  </div>
                ))}
              </div>
            </section>
          ))}

          <section style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>
              Builder previews — what people are making ({data.previews.length})
            </h2>
            <p style={{ fontSize: 12, opacity: 0.6, marginBottom: 12 }}>
              Anonymous snapshots, rendered exactly as the builder showed them. If one looks broken, that&apos;s a rendering bug to chase.
            </p>
            {data.previews.length === 0 && <p style={{ opacity: 0.5, fontSize: 13 }}>No previews captured yet.</p>}
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              {data.previews.map((s, i) => (
                <SnapshotCard key={i} snap={s} />
              ))}
            </div>
          </section>

          <section style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>Recent failures</h2>
            {Object.entries(data.samples).map(([event, arr]) =>
              arr.length > 0 ? (
                <div key={event} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#f87171" }}>{event} ({arr.length})</div>
                  {arr.slice(0, 10).map((s, i) => (
                    <div key={i} style={{ fontSize: 12, opacity: 0.75, fontFamily: "monospace" }}>
                      {fmtTime(s.at)}{s.detail ? ` — ${s.detail}` : ""}
                    </div>
                  ))}
                </div>
              ) : null,
            )}
          </section>
        </>
      )}
    </main>
  );
}
