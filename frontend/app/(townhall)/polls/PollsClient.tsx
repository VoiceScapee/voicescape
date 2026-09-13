"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PresenceDot } from "@/components/townhall/Presence";
import { useWriteGate } from "@/components/townhall/useTownhall";
import { useHcsSubmit } from "@/components/townhall/useHcsSubmit";
import { useStreamEvents } from "@/components/townhall/useStream";
import { useConfirmedTransaction } from "@/hooks/useConfirmedTransaction";
import { TxConfirming, TxReceipt } from "@/components/TxConfirm";
import { recordConversionEvent } from "@/lib/metrics";
import { getActiveChain } from "@/lib/chains";
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
  // Reactive finality: after the wallet approves, poll the mirror node
  // until the vote reaches consensus — the UI reacts to the real outcome.
  const [confirmTxId, setConfirmTxId] = useState<string | null>(null);
  const confirmStatus = useConfirmedTransaction(confirmTxId);
  const [approvedAt, setApprovedAt] = useState<number | null>(null);
  const [finalizedAt, setFinalizedAt] = useState<Date | null>(null);
  const [confirmedChoice, setConfirmedChoice] = useState<string | null>(null);
  // Submitted but the mirror node hasn't shown it yet — honest delayed state.
  const [submittedTxId, setSubmittedTxId] = useState<string | null>(null);
  const chain = getActiveChain();
  const total = proposal.yes + proposal.no + proposal.abstain;

  const vote = async (choice: "yes" | "no" | "abstain") => {
    setError(null);
    setSubmittedTxId(null);
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
      // Wallet approved — start the finality clock and the mirror poll.
      // The vote is on-chain from here; buttons stay busy until the
      // network verdict lands.
      setApprovedAt(Date.now());
      setConfirmedChoice(choice);
      setConfirmTxId(hcsTxId);
      await postJson(`/api/townhall/proposals/${encodeURIComponent(proposal.id)}/vote`, {
        voter: me,
        choice,
        hcsTxId,
      });
      // Tally refresh happens on "confirmed" below.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
      setConfirmTxId(null);
    }
  };

  // Mirror-node verdict landed — move to the matching end state.
  useEffect(() => {
    if (!confirmTxId) return;
    if (confirmStatus === "confirmed") {
      setFinalizedAt(new Date());
      setBusy(null);
      recordConversionEvent("vote_submitted");
      onVoted();
    } else if (confirmStatus === "failed") {
      setError("The vote transaction failed on Hedera — your vote was not counted.");
      setBusy(null);
      recordConversionEvent("vote_failed");
      setConfirmTxId(null);
    } else if (confirmStatus === "timeout") {
      // Submitted but not yet visible (mirror lag). The vote is on-chain —
      // never claim failure; show the honest "submitted" state.
      setSubmittedTxId(confirmTxId);
      setBusy(null);
      setConfirmTxId(null);
      onVoted();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmStatus]);

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
              {busy === c
                ? confirmStatus === "confirming"
                  ? "Confirming…"
                  : "Voting…"
                : c === "yes"
                  ? "Vote yes"
                  : c === "no"
                    ? "Vote no"
                    : "Abstain"}
            </button>
          ))}
        </div>
      ) : (
        <p className="th-muted">Voting closed.</p>
      )}
      {error && <p className="th-error">{error}</p>}
      {hcs.phase.kind === "error" && <p className="th-error">Failed to submit: {hcs.phase.message}</p>}
      {confirmStatus === "confirming" && (
        <div style={{ marginTop: 8 }}>
          <TxConfirming
            title="Confirming your vote…"
            sub="Approved in your wallet — waiting for Hedera to reach consensus (usually a few seconds)."
          />
        </div>
      )}
      {confirmStatus === "confirmed" && confirmTxId && finalizedAt && (
        <div style={{ marginTop: 8 }}>
          <TxReceipt
            title="Vote confirmed"
            approvedAt={approvedAt}
            finalizedAt={finalizedAt}
            txId={confirmTxId}
            explorerBase={chain.blockExplorer}
            lines={[
              { label: "Choice", value: confirmedChoice ?? "—" },
              { label: "Proposal", value: proposal.title },
            ]}
            nextStep="Your vote is on-chain and counted in the tally above."
            onDone={() => {
              setConfirmTxId(null);
              setConfirmedChoice(null);
              setFinalizedAt(null);
            }}
          />
        </div>
      )}
      {submittedTxId && (
        <p className="th-muted" style={{ marginTop: 8 }}>
          ◌ Vote submitted to Hedera, but confirmation is delayed — it will be counted once the network catches up.{" "}
          <a
            href={`${chain.blockExplorer}/transaction/${submittedTxId}`}
            target="_blank"
            rel="noreferrer"
            className="th-identity-link"
          >
            View on HashScan
          </a>
        </p>
      )}
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
  // Reactive finality for the proposal HCS transaction.
  const [confirmTxId, setConfirmTxId] = useState<string | null>(null);
  const confirmStatus = useConfirmedTransaction(confirmTxId);
  const [approvedAt, setApprovedAt] = useState<number | null>(null);
  const [finalizedAt, setFinalizedAt] = useState<Date | null>(null);
  const [submittedTxId, setSubmittedTxId] = useState<string | null>(null);
  const chain = getActiveChain();

  const resetForm = () => {
    setTitle("");
    setBody("");
    setClosesAt("");
    setConfirmTxId(null);
    setFinalizedAt(null);
    setSubmittedTxId(null);
    setOpen(false);
  };

  const submit = async () => {
    setSubmitError(null);
    setSubmittedTxId(null);
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
    // Wallet approved — start the finality clock and the mirror poll.
    setApprovedAt(Date.now());
    setConfirmTxId(hcsTxId);
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
      setConfirmTxId(null);
      return;
    }
    // List refresh happens on "confirmed" below; the form stays open
    // showing the confirmation state until the user dismisses it.
  };

  // Mirror-node verdict landed — move to the matching end state.
  useEffect(() => {
    if (!confirmTxId) return;
    if (confirmStatus === "confirmed") {
      setFinalizedAt(new Date());
      recordConversionEvent("proposal_submitted");
      onCreated();
    } else if (confirmStatus === "failed") {
      setSubmitError("The proposal transaction failed on Hedera — it was not published.");
      recordConversionEvent("proposal_failed");
      setConfirmTxId(null);
    } else if (confirmStatus === "timeout") {
      // Submitted but not yet visible (mirror lag) — never claim failure.
      setSubmittedTxId(confirmTxId);
      setConfirmTxId(null);
      onCreated();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmStatus]);

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
            disabled={!title.trim() || !body.trim() || !closesAt || !canWrite || hcs.phase.kind === "submitting" || confirmStatus === "confirming" || confirmStatus === "confirmed"}
          >
            {hcs.phase.kind === "submitting"
              ? "Sign in wallet…"
              : confirmStatus === "confirming"
                ? "Confirming…"
                : "Publish proposal"}
          </button>
          <button type="button" className="vs-btn vs-btn-ghost th-btn-sm" onClick={() => setOpen(false)} disabled={confirmStatus === "confirming"}>
            Cancel
          </button>
        </div>
        {!canWrite && <p className="th-muted">{isAuthenticated ? "Set your page username (top of the page) to propose." : "Sign in with your wallet to propose."}</p>}
        {hcs.phase.kind === "error" && (
          <p className="th-error">Failed to submit: {hcs.phase.message}</p>
        )}
        {submitError && <p className="th-error">{submitError}</p>}
        {confirmStatus === "confirming" && (
          <div style={{ marginTop: 8 }}>
            <TxConfirming
              title="Confirming your proposal…"
              sub="Approved in your wallet — waiting for Hedera to reach consensus (usually a few seconds)."
            />
          </div>
        )}
        {confirmStatus === "confirmed" && confirmTxId && finalizedAt && (
          <div style={{ marginTop: 8 }}>
            <TxReceipt
              title="Proposal published"
              approvedAt={approvedAt}
              finalizedAt={finalizedAt}
              txId={confirmTxId}
              explorerBase={chain.blockExplorer}
              lines={[
                { label: "Title", value: title.trim() || "—" },
                { label: "Voting closes", value: closesAt || "—" },
              ]}
              nextStep="Your proposal is on-chain and live in the list below."
              onDone={() => {
                resetForm();
                onCreated();
              }}
            />
          </div>
        )}
        {submittedTxId && (
          <p className="th-muted" style={{ marginTop: 8 }}>
            ◌ Proposal submitted to Hedera, but confirmation is delayed — it will appear once the network catches up.{" "}
            <a
              href={`${chain.blockExplorer}/transaction/${submittedTxId}`}
              target="_blank"
              rel="noreferrer"
              className="th-identity-link"
            >
              View on HashScan
            </a>
          </p>
        )}
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
