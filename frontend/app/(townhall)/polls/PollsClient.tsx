"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import DustFeeGate from "@/components/townhall/DustFeeGate";
import { useDustFee, useWriteGate } from "@/components/townhall/useTownhall";
import { getJson, postJson, type Proposal } from "@/lib/townhall";

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
  const countdown = useCountdown(proposal.closesAt);
  const closed = proposal.closesAt <= Date.now();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const total = proposal.yes + proposal.no + proposal.abstain;

  const vote = async (choice: "yes" | "no" | "abstain") => {
    setError(null);
    if (!canWrite) {
      setError(isAuthenticated ? "Set your page username (top of the page) to vote." : "Sign in with your wallet to vote.");
      return;
    }
    setBusy(choice);
    try {
      await postJson(`/api/townhall/proposals/${encodeURIComponent(proposal.id)}/vote`, {
        voter: me,
        choice,
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
    </div>
  );
}

function NewProposalForm({ onCreated }: { onCreated: () => void }) {
  const { username: me, canWrite, isAuthenticated } = useWriteGate();
  const dust = useDustFee();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [open, setOpen] = useState(false);

  const submit = async () => {
    if (!title.trim() || !body.trim() || !closesAt || !canWrite) return;
    const ts = new Date(closesAt).getTime();
    if (!Number.isFinite(ts) || ts <= Date.now()) return;
    const ok = await dust.execute(async (dustFeeTxId) => {
      await postJson("/api/townhall/proposals", {
        author: me,
        title: title.trim(),
        body: body.trim(),
        closesAt: ts,
        dustFeeTxId,
      });
    });
    if (ok) {
      setTitle("");
      setBody("");
      setClosesAt("");
      setOpen(false);
      onCreated();
    }
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
            disabled={!title.trim() || !body.trim() || !closesAt || !canWrite || dust.phase.kind === "working" || dust.phase.kind === "paying"}
          >
            {dust.phase.kind === "working" || dust.phase.kind === "paying" ? "Publishing…" : "Publish proposal"}
          </button>
          <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
        {!canWrite && <p className="th-muted">{isAuthenticated ? "Set your page username (top of the page) to propose." : "Sign in with your wallet to propose."}</p>}
        <DustFeeGate flow={dust} actionLabel="proposal" />
      </div>
    </div>
  );
}

export default function PollsClient() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ proposals?: Proposal[] }>("/api/townhall/proposals");
      const list = Array.isArray(data.proposals) ? data.proposals : [];
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

  const open = proposals.filter((p) => p.closesAt > Date.now());
  const closed = proposals.filter((p) => p.closesAt <= Date.now());

  return (
    <>
      <div className="th-page-head">
        <h1>🏛️ <span className="vs-gradient-text">Polls</span></h1>
        <p>Advisory community polls — signaling only, no on-chain execution. Publishing a poll costs the dust fee; voting is free.</p>
      </div>

      <div className="th-section">
        <NewProposalForm onCreated={load} />
      </div>

      {loading && <p className="th-muted">Loading proposals…</p>}
      {error && (
        <p className="th-error">
          Couldn&apos;t load proposals: {error}{" "}
          <button type="button" className="th-identity-link" onClick={load}>
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
