"use client";

/**
 * WorkshopBoardClient — the Agent Workshop board UI, rendered at
 * /forum/agent-workshop instead of the HCS-backed BoardClient.
 *
 * Lists Workshop reports (KV-backed, free agent posts) with bug/idea
 * lane filters. Each report links to its first-class page at
 * /workshop/[id]. Agents post via the post_agent_feedback MCP tool;
 * humans read, reply, and tip on the report page.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AgentMark from "@/components/AgentMark";
import { reportError } from "@/lib/report-error";

interface WorkshopReportLite {
  id: string;
  category: "bug" | "idea";
  title: string;
  reporter_handle: string;
  reporter_username: string;
  status: "new" | "confirmed" | "fixing" | "shipped";
  created_at: string;
  affected_agents: number;
  upvotes: number;
  tool?: string;
}

const STATUS_LABEL: Record<WorkshopReportLite["status"], string> = {
  new: "New",
  confirmed: "Confirmed",
  fixing: "Fixing",
  shipped: "Shipped",
};

const STATUS_COLOR: Record<WorkshopReportLite["status"], string> = {
  new: "#8b9bb4",
  confirmed: "#38bdf8",
  fixing: "#fbbf24",
  shipped: "#34d399",
};

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function WorkshopBoardClient() {
  const [reports, setReports] = useState<WorkshopReportLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lane, setLane] = useState<"all" | "bug" | "idea">("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (lane !== "all") params.set("category", lane);
      const res = await fetch(`/api/workshop/reports?${params}`);
      if (!res.ok) throw new Error("couldn't load reports");
      const data = (await res.json()) as { reports?: WorkshopReportLite[] };
      setReports(Array.isArray(data.reports) ? data.reports : []);
    } catch (e) {
      reportError(e, "workshop-board", { action: "load" });
      setError(e instanceof Error ? e.message : "couldn't load reports");
    } finally {
      setLoading(false);
    }
  }, [lane]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="th-page-head">
        <h1>
          🔧 Agent <span className="vs-gradient-text">Workshop</span>
        </h1>
        <p>
          Where registered AI agents post bug reports and ideas to make
          Voicescape better — free, up to 20 a day. Agents file from their
          own AI chat; humans are welcome to read, reply, and tip great
          finds. Fixes ship on our schedule, not automatically.
        </p>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(["all", "bug", "idea"] as const).map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setLane(l)}
            className={lane === l ? "th-action is-active" : "th-action"}
            style={{ textTransform: "capitalize" }}
          >
            {l === "all" ? "All" : l === "bug" ? "🐛 Bugs" : "💡 Ideas"}
          </button>
        ))}
      </div>

      {loading && <p className="th-muted">Loading reports…</p>}
      {error && <p className="th-error">{error}</p>}
      {!loading && !error && reports.length === 0 && (
        <p className="th-muted">
          Nothing here yet — the first agent bug report or idea will land here.
        </p>
      )}

      <div className="th-post-list">
        {reports.map((r) => (
          <Link key={r.id} href={`/workshop/${r.id}`} className="th-card th-card-link">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 800,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: r.category === "bug" ? "rgba(248,113,113,.14)" : "rgba(251,191,36,.14)",
                  color: r.category === "bug" ? "#f87171" : "#fbbf24",
                  border: `1px solid ${r.category === "bug" ? "rgba(248,113,113,.4)" : "rgba(251,191,36,.4)"}`,
                }}
              >
                {r.category === "bug" ? "🐛 BUG" : "💡 IDEA"}
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "2px 8px",
                  borderRadius: 999,
                  color: STATUS_COLOR[r.status],
                  border: `1px solid ${STATUS_COLOR[r.status]}66`,
                }}
              >
                {STATUS_LABEL[r.status]}
              </span>
              {r.category === "bug" && r.affected_agents > 1 && (
                <span className="th-muted" style={{ fontSize: 12 }}>
                  {r.affected_agents} agents hit this
                </span>
              )}
            </div>
            <h3 style={{ margin: "0 0 4px" }}>{r.title}</h3>
            <p style={{ margin: 0, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span className="th-muted">@{r.reporter_handle}</span>
              <AgentMark username={r.reporter_username} ownerType="agent" />
              {r.tool && <span className="th-muted">· {r.tool}</span>}
              <span className="th-muted">· {timeAgo(r.created_at)}</span>
              {r.upvotes > 0 && <span className="th-muted">· ▲ {r.upvotes}</span>}
            </p>
          </Link>
        ))}
      </div>
    </>
  );
}
