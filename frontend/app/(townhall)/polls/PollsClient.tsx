"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PresenceDot } from "@/components/townhall/Presence";
import { useWriteGate } from "@/components/townhall/useTownhall";
import { useHcsSubmit } from "@/components/townhall/useHcsSubmit";
import { useStreamEvents } from "@/components/townhall/useStream";
import { getJson, postJson, makeTownhallId, type Proposal } from "@/lib/townhall";

/** Stream event: a new proposal or vote — the client refetches tallies. */
interface ProposalStreamEvent {
  seq: number;
  kind: "proposal" | "proposal-vote";
  id: string;
}

function isProposalStreamEvent(m: unknown): m is ProposalStreamEvent {
  // Accepts SSE stream events ({seq, kind}) AND polling fallback proposal
  // objects ({id, ...}) — the onEvents handler ignores the data and reloads.
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  if (typeof o.seq === "number" && (o.kind === "proposal" || o.kind === "proposal-vote")) return true;
  return typeof o.id === "string";
}

/**
 * The REST API passes closesAt through from the HCS message, which carries
 * an ISO-8601 string; the client type is epoch ms. Normalize once at the
 * boundary so countdowns and sorting behave.
 */
function normalizeProposal(p: Proposal): Proposal {
  const c = (p as unknown as { closesAt: unknown }).closesAt;
  return {
    ...p,
    closesAt: typeof c === "string" ? Date.parse(c) : typeof c === "number" ? c : 0,
  };
}

function useCountdown(closesAt: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = closesAt - now;
  if (ms <= 0) return "closed";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m ${sec}s left`;
  return `${sec}s left`;
}

function ProposalCard({ proposal, onVoted }: { proposal: Proposal; onVoted: () => void }) {
  const { username: me, canWrite, isAuthenticated } = useWriteGate();
  const hcs = useHcsSubmit();
  const countdown = useCountdown(proposal.closesAt);
  const closed = proposal.closesAt <= Date.now();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const total = proposal.yes + proposal.no + proposal.abstain;

  const vote = async (choice: "yes" | "no" | "abstain") => {
    setError(null);
    if (!canWrite || !me) {
      setError(isAuthenticated ? "Set your page username (top of the page) to vote." : "Sign in with your wallet to vote.");
      return;
    }
    setBusy(choice);
    try {
      // Submit the vote via the user's wallet, then notify the server
      // (it verifies the HCS tx via mirror node).
      const hcsTxId = await hcs.submit("governance", {
        v: 1,
        kind: "proposal-vote",
        ts: new Date().toISOString(),
        author: me,
        proposal: proposal.id,
        voter: me,
        choice,
      });
      if (!hcsTxId) return; // User cancelled or error
      await postJson(`/api/townhall/proposals/${encodeURIComponent(proposal.id)}/vote`, {
        voter: me,
        choice,
        hcsTxId,
      });
      onVoted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

  return (
    <div className="th-card">
      <div className="th-between">
        <h3>{proposal.title}</h3>
        <span className={`th-countdown${closed ? " is-closed" : ""}`}>{countdown}</span>
      </div>
      <p>
        by{" "}
        <Link href={`/${proposal.author}`} className="th-post-author">
          @{proposal.author}
        </Link>
      </p>
      <p style={{ whiteSpace: "pre-wrap", color: "var(--vs-text)" }}>{proposal.body}</p>
      <div className="th-tally" aria-label="Vote tally">
        <span className="th-tally-item is-yes">yes {proposal.yes} ({pct(proposal.yes)}%)</span>
        <span className="th-tally-item is-no">no {proposal.no} ({pct(proposal.no)}%)</span>
        <span className="th-tally-item">abstain {proposal.abstain} ({pct(proposal.abstain)}%)</span>
      </div>
      {!closed ? (
        <div className="th-vote-btns">
          {(["yes", "no", "abstain"] as const).map((c) => (
            <button
              key={c}
              type="button"
              className={`vs-btn ${c === "yes" ? "vs-btn-primary" : "vs-btn-ghost"} th-btn-sm`}
              onClick={() => vote(c)}
              disabled={busy !== null}
            >
              {busy === c ? "Voting…" : c === "yes" ? "Vote yes" : c === "no" ? "Vote no" : "Abstain"}
            </button>
          ))}
        </div>
      ) : (
        <p className="th-muted">Voting closed.</p>
      )}
      {error && <p className="th-error">{error}</p>}
      {hcs.phase.kind === "error" && <p className="th-error">Failed to submit: {hcs.phase.message}</p>}
    </div>
  );
}

function NewProposalForm({ onCreated }: { onCreated: () => void }) {
  const { username: me, canWrite, isAuthenticated } = useWriteGate();
  const hcs = useHcsSubmit();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [open, setOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitError(null);
    if (!title.trim() || !body.trim() || !closesAt || !canWrite || !me) return;
    const ts = new Date(closesAt).getTime();
    if (!Number.isFinite(ts) || ts <= Date.now()) return;
    const t = title.trim();
    const b = body.trim();
    const closesIso = new Date(ts).toISOString();
    const id = makeTownhallId(t);
    // Submit the proposal via the user's wallet, then notify the server
    // (it verifies the HCS tx via mirror node).
    const hcsTxId = await hcs.submit("governance", {
      v: 1,
      kind: "proposal",
      ts: new Date().toISOString(),
      author: me,
      id,
      title: t,
      body: b,
      closesAt: closesIso,
    });
    if (!hcsTxId) return; // User cancelled or error — phase shows the error
    try {
      await postJson("/api/townhall/proposals", {
        author: me,
        id,
        title: t,
        body: b,
        closesAt: closesIso,
        hcsTxId,
      });
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
      return;
    }
    setTitle("");
    setBody("");
    setClosesAt("");
    setOpen(false);
    onCreated();
  };

  if (!open) {
    return (
      <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={() => setOpen(true)}>
        + New proposal
      </button>
    );
  }

  return (
    <div className="th-card">
      <h3>New proposal</h3>
      <div className="th-form">
        <div>
          <label className="vs-label" htmlFor="prop-title">Title</label>
          <input
            id="prop-title"
            className="vs-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What should the town decide?"
            maxLength={140}
          />
        </div>
        <div>
          <label className="vs-label" htmlFor="prop-body">Details</label>
          <textarea
            id="prop-body"
            className="vs-input th-textarea"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Background, options, what happens if it passes…"
            rows={4}
          />
        </div>
        <div>
          <label className="vs-label" htmlFor="prop-closes">Voting closes</label>
          <input
            id="prop-closes"
            className="vs-input"
            type="datetime-local"
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
          />
        </div>
        <div className="th-row">
          <button
            type="button"
            className="vs-btn vs-btn-primary th-btn-sm"
            onClick={submit}
            disabled={!title.trim() || !body.trim() || !closesAt || !canWrite || hcs.phase.kind === "submitting"}
          >
            {hcs.phase.kind === "submitting" ? "Sign in wallet…" : "Publish proposal"}
          </button>
          <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
        {!canWrite && <p className="th-muted">{isAuthenticated ? "Set your page username (top of the page) to propose." : "Sign in with your wallet to propose."}</p>}
        {hcs.phase.kind === "error" && (
          <p className="th-error">Failed to submit: {hcs.phase.message}</p>
        )}
        {submitError && <p className="th-error">{submitError}</p>}
      </div>
    </div>
  );
}

export default function PollsClient() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ proposals?: Proposal[] }>("/api/townhall/proposals");
      const list = Array.isArray(data.proposals) ? data.proposals.map(normalizeProposal) : [];
      list.sort((a, b) => b.closesAt - a.closesAt);
      setProposals(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Live: any new proposal or vote refetches the (small) proposal list quietly.
  useStreamEvents<ProposalStreamEvent>(
    "/api/townhall/proposals/stream",
    () => load(true),
    isProposalStreamEvent,
    { dataKey: "proposals" },
  );

  const open = proposals.filter((p) => p.closesAt > Date.now());
  const closed = proposals.filter((p) => p.closesAt <= Date.now());

  return (
    <>
      <div className="th-page-head">
        <h1>🏛️ <span className="vs-gradient-text">Polls</span></h1>
        <p>Advisory community polls — signaling only, no on-chain execution. You sign proposals and votes in your wallet — transparent and on-chain. <PresenceDot scope="polls" /></p>
      </div>

      <div className="th-section">
        <NewProposalForm onCreated={load} />
      </div>

      {loading && <p className="th-muted">Loading proposals…</p>}
      {error && (
        <p className="th-error">
          Couldn&apos;t load proposals: {error}{" "}
          <button type="button" className="th-identity-link" onClick={() => load()}>
            retry
          </button>
        </p>
      )}

      {!loading && !error && (
        <>
          {open.length > 0 && (
            <div className="th-section">
              <h2 className="th-h2">Open votes ({open.length})</h2>
              {open.map((p) => (
                <ProposalCard key={p.id} proposal={p} onVoted={load} />
              ))}
            </div>
          )}
          {closed.length > 0 && (
            <div className="th-section">
              <h2 className="th-h2">Closed ({closed.length})</h2>
              {closed.map((p) => (
                <ProposalCard key={p.id} proposal={p} onVoted={load} />
              ))}
            </div>
          )}
          {proposals.length === 0 && <p className="th-muted">No proposals yet.</p>}
        </>
      )}
    </>
  );
}
