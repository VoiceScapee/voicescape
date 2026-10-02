"use client";

/**
 * /v/manage — the human's vault dashboard.
 *
 * Pairing is the only auth (no session). Connect a wallet → see every
 * spending account registered under it → pick one → balance, status,
 * recent activity, and three actions: cut off the agent, sweep the funds
 * back, or sign as the vault (update a blockpage the vault owns).
 *
 * Copy is plain words everywhere — a spending account, never a KeyList;
 * one-line errors that say what happened and what to do next.
 */
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { WalletConnect } from "@/components/WalletConnect";
import { requestWalletConnectUI, useWallet } from "@/lib/wallet";
import {
  submitPreparedTx,
  hashscanTxUrl,
  type SubmitPreparedTxResult,
} from "@/lib/prepared-tx";
import {
  fetchMyVaults,
  fetchVaultHealth,
  prepareVaultRevoke,
  prepareVaultSweep,
  prepareVaultUpdate,
  VaultLinkError,
  type VaultHealthView,
} from "@/lib/vault-link";

type ActionState =
  | { kind: "idle" }
  | { kind: "confirm"; what: string }
  | { kind: "working"; what: string }
  | { kind: "done"; what: string; txUrl: string }
  | { kind: "error"; what: string };

interface MirrorTxn {
  transaction_id: string;
  name: string;
  consensus_timestamp: string;
}

const shell: React.CSSProperties = {
  maxWidth: 480,
  margin: "0 auto",
  padding: "32px 20px 64px",
  color: "#f2ecff",
};

const eyebrow: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  opacity: 0.6,
  marginBottom: 8,
};

const card: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,.14)",
  borderRadius: 12,
  padding: "14px 16px",
  marginBottom: 12,
  fontSize: 15,
  lineHeight: 1.65,
};

const primaryButton: React.CSSProperties = {
  width: "100%",
  padding: "16px",
  borderRadius: 12,
  border: "none",
  background: "linear-gradient(135deg,#7b3ff2,#b45cf0)",
  color: "white",
  fontSize: 17,
  fontWeight: 800,
  cursor: "pointer",
};

const ghostButton: React.CSSProperties = {
  width: "100%",
  padding: "14px",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,.2)",
  background: "rgba(255,255,255,.06)",
  color: "#f2ecff",
  fontSize: 15,
  fontWeight: 700,
  cursor: "pointer",
};

const dangerButton: React.CSSProperties = {
  ...ghostButton,
  border: "1px solid rgba(255,120,120,.5)",
  background: "rgba(255,80,80,.08)",
};

const STATUS_WORDS: Record<string, { label: string; color: string; bg: string }> = {
  healthy: { label: "All good", color: "#7dffa8", bg: "rgba(80,255,150,.1)" },
  "low-balance": { label: "Low balance", color: "#ffd27d", bg: "rgba(255,200,100,.1)" },
  empty: { label: "Empty", color: "#ffd27d", bg: "rgba(255,200,100,.1)" },
  revoked: { label: "Agent cut off", color: "#9db4ff", bg: "rgba(150,170,255,.1)" },
  "key-changed": { label: "Keys changed — look at this", color: "#ff9d9d", bg: "rgba(255,80,80,.1)" },
  unverified: { label: "Can't verify yet", color: "#b9b9c7", bg: "rgba(255,255,255,.06)" },
  "not-found": { label: "Couldn't check", color: "#b9b9c7", bg: "rgba(255,255,255,.06)" },
  unknown: { label: "Couldn't check", color: "#b9b9c7", bg: "rgba(255,255,255,.06)" },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_WORDS[status] ?? STATUS_WORDS.unknown;
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: 13,
        fontWeight: 800,
        color: s.color,
        background: s.bg,
        borderRadius: 999,
        padding: "4px 12px",
      }}
    >
      {s.label}
    </span>
  );
}

function friendlyTxnName(name: string): string {
  const map: Record<string, string> = {
    CRYPTOTRANSFER: "Transfer",
    CONTRACTCALL: "App call",
    CRYPTOUPDATE: "Account change",
    CRYPTOCREATEACCOUNT: "Account created",
    TOKENASSOCIATE: "Token linked",
    CONSENSUSSUBMITMESSAGE: "Message posted",
  };
  return map[name] ?? name.toLowerCase().replace(/_/g, " ");
}

function friendlyDate(ts: string): string {
  const secs = Number(ts.split(".")[0]);
  if (!Number.isFinite(secs)) return "";
  return new Date(secs * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function shortCode(fp: string): string {
  return fp.length > 20 ? `${fp.slice(0, 8)}…${fp.slice(-8)}` : fp;
}

function ManageInner() {
  const searchParams = useSearchParams();
  const { account: accountId } = useWallet();
  const [vaults, setVaults] = useState<VaultHealthView[] | null>(null);
  const [vaultsError, setVaultsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(
    () => searchParams.get("vault"),
  );
  const [health, setHealth] = useState<VaultHealthView | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [txns, setTxns] = useState<MirrorTxn[] | null>(null);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [updateName, setUpdateName] = useState("");
  const [updateCid, setUpdateCid] = useState("");
  const [preparedUpdateNote, setPreparedUpdateNote] = useState<string | null>(null);

  const loadVaults = useCallback(() => {
    if (!accountId) return;
    setVaultsError(null);
    fetchMyVaults(accountId)
      .then((r) => {
        setVaults(r.vaults);
        if (r.vaults.length === 1) setSelected((s) => s ?? r.vaults[0].vault_account_id);
      })
      .catch((e) =>
        setVaultsError(e instanceof VaultLinkError ? e.message : "Couldn't load your vaults — try again in a moment."),
      );
  }, [accountId]);

  useEffect(() => {
    loadVaults();
  }, [loadVaults]);

  const loadHealth = useCallback(() => {
    if (!selected) return;
    setHealthLoading(true);
    setHealthError(null);
    fetchVaultHealth(selected)
      .then((h) => setHealth(h))
      .catch((e) =>
        setHealthError(e instanceof VaultLinkError ? e.message : "Couldn't check this vault — try again in a moment."),
      )
      .finally(() => setHealthLoading(false));
    // Recent activity, straight from the Hedera mirror node.
    setTxns(null);
    fetch(
      `https://mainnet.mirrornode.hedera.com/api/v1/transactions?account.id=${encodeURIComponent(selected)}&limit=15&order=desc`,
      { headers: { Accept: "application/json" } },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b && Array.isArray(b.transactions)) setTxns(b.transactions as MirrorTxn[]);
        else setTxns([]);
      })
      .catch(() => setTxns([]));
  }, [selected]);

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  /** Run a prepared unsigned tx through the wallet; plain-words outcome. */
  const runPrepared = useCallback(
    async (prepared: { unsigned_tx_bytes: string; transaction_id: string }, doneWord: string) => {
      if (!accountId) return;
      setAction({ kind: "working", what: "Waiting for your wallet — confirm in the wallet app…" });
      try {
        const result: SubmitPreparedTxResult = await submitPreparedTx(
          {
            transactionList: prepared.unsigned_tx_bytes,
            signerAccountId: accountId,
            transactionId: prepared.transaction_id,
          },
          { restoreIfMissing: true },
        );
        const url = hashscanTxUrl(result.txId);
        if (result.confirmed) {
          setAction({ kind: "done", what: doneWord, txUrl: url });
        } else {
          setAction({
            kind: "done",
            what: "Sent — it may still be confirming on Hedera. Give it a minute, then check the receipt link.",
            txUrl: url,
          });
        }
        loadVaults();
        loadHealth();
      } catch (e) {
        setAction({
          kind: "error",
          what: e instanceof VaultLinkError || e instanceof Error ? e.message : "Something went wrong — try again in a moment.",
        });
      }
    },
    [accountId, loadVaults, loadHealth],
  );

  const doRevoke = useCallback(async () => {
    if (!selected || !accountId) return;
    setAction({ kind: "working", what: "Preparing…" });
    try {
      const prepared = await prepareVaultRevoke(selected, accountId);
      await runPrepared(prepared, "Done — your agent can't touch this account any more. The funds are still in the account; sweep them below if you want them back.");
    } catch (e) {
      setAction({
        kind: "error",
        what: e instanceof VaultLinkError ? e.message : "Couldn't prepare that — try again in a moment.",
      });
    }
  }, [selected, accountId, runPrepared]);

  const doSweep = useCallback(async () => {
    if (!selected || !accountId) return;
    setAction({ kind: "working", what: "Preparing…" });
    try {
      const prepared = await prepareVaultSweep(selected, accountId);
      await runPrepared(
        prepared,
        `Done — ${prepared.amount_hbar.toFixed(2)} HBAR is on its way back to your wallet.`,
      );
    } catch (e) {
      setAction({
        kind: "error",
        what: e instanceof VaultLinkError ? e.message : "Couldn't prepare that — try again in a moment.",
      });
    }
  }, [selected, accountId, runPrepared]);

  const doPrepareUpdate = useCallback(async () => {
    if (!selected || !accountId) return;
    const name = updateName.trim().toLowerCase().replace(/^@/, "");
    const cid = updateCid.trim();
    if (!name || !cid) {
      setAction({ kind: "error", what: "Fill in both the blockpage username and the new IPFS link." });
      return;
    }
    setAction({ kind: "working", what: "Preparing the update…" });
    setPreparedUpdateNote(null);
    try {
      const prepared = await prepareVaultUpdate(selected, accountId, name, cid);
      setPreparedUpdateNote(prepared.what_youre_signing);
      setAction({ kind: "confirm", what: "update" });
    } catch (e) {
      setAction({
        kind: "error",
        what: e instanceof VaultLinkError ? e.message : "Couldn't prepare the update — try again in a moment.",
      });
    }
  }, [selected, accountId, updateName, updateCid]);

  const doSignUpdate = useCallback(async () => {
    if (!selected || !accountId) return;
    const name = updateName.trim().toLowerCase().replace(/^@/, "");
    const cid = updateCid.trim();
    setAction({ kind: "working", what: "Preparing the update…" });
    try {
      const prepared = await prepareVaultUpdate(selected, accountId, name, cid);
      await runPrepared(prepared, `Done — @${name}'s blockpage now points at the new content.`);
    } catch (e) {
      setAction({
        kind: "error",
        what: e instanceof VaultLinkError ? e.message : "Couldn't sign that — try again in a moment.",
      });
    }
  }, [selected, accountId, updateName, updateCid, runPrepared]);

  const selectedVault = vaults?.find((v) => v.vault_account_id === selected) ?? null;
  const detail = health ?? selectedVault;

  return (
    <main style={shell}>
      <WalletConnect />
      <div style={eyebrow}>Voicescape · Vault dashboard</div>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 4px" }}>Agent spending accounts</h1>
      <p style={{ margin: "0 0 16px", opacity: 0.75, fontSize: 15, lineHeight: 1.6 }}>
        Every account your agents spend from. Watch them here — cut one off any time.
      </p>

      {!accountId && (
        <button onClick={requestWalletConnectUI} style={primaryButton}>
          Connect wallet to see your vaults
        </button>
      )}

      {accountId && vaultsError && (
        <div style={{ ...card, border: "1px solid rgba(255,120,120,.4)", background: "rgba(255,80,80,.06)" }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>Couldn't load your vaults</div>
          <div style={{ fontSize: 14, opacity: 0.9 }}>{vaultsError}</div>
          <button onClick={loadVaults} style={{ ...ghostButton, marginTop: 12 }}>
            Try again
          </button>
        </div>
      )}

      {accountId && vaults !== null && vaults.length === 0 && (
        <div style={card}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>No spending accounts yet</div>
          <div style={{ fontSize: 14, opacity: 0.85, lineHeight: 1.6 }}>
            Ask your AI agent to set one up — it drops you a one-tap setup link right in
            your chat. One signature, and your agent gets its own account to pay its gas from.
          </div>
        </div>
      )}

      {accountId && vaults !== null && vaults.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          {vaults.map((v) => (
            <button
              key={v.vault_account_id}
              onClick={() => {
                setSelected(v.vault_account_id);
                setAction({ kind: "idle" });
                setPreparedUpdateNote(null);
              }}
              style={{
                ...ghostButton,
                marginBottom: 8,
                textAlign: "left",
                border:
                  v.vault_account_id === selected
                    ? "1px solid #b45cf0"
                    : "1px solid rgba(255,255,255,.2)",
              }}
            >
              <span style={{ fontFamily: "monospace", fontSize: 14 }}>{v.vault_account_id}</span>
              {v.balance_hbar !== null && (
                <span style={{ float: "right", opacity: 0.85 }}>{v.balance_hbar.toFixed(2)} HBAR</span>
              )}
            </button>
          ))}
        </div>
      )}

      {accountId && detail && (
        <>
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <code style={{ fontSize: 15 }}>{detail.vault_account_id}</code>
              <StatusBadge status={detail.status} />
            </div>
            <div style={{ marginTop: 10, fontSize: 15 }}>
              <strong>Balance:</strong>{" "}
              {detail.balance_hbar === null ? "couldn't read" : `${detail.balance_hbar.toFixed(4)} HBAR`}
            </div>
            {detail.status_detail && (
              <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>
                {detail.status_detail}
              </div>
            )}
            {detail.key_fingerprint && detail.key_fingerprint.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 14, opacity: 0.9 }}>
                <strong>Access codes on this account:</strong>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {detail.key_fingerprint.map((fp, i) => (
                    <li key={i} style={{ fontSize: 13 }}>
                      <code style={{ background: "rgba(255,255,255,.08)", padding: "2px 8px", borderRadius: 6 }}>
                        {shortCode(fp)}
                      </code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {detail.guidance && (
              <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>
                {detail.guidance}
              </div>
            )}
            <a
              href={detail.hashscan_url}
              target="_blank"
              rel="noreferrer"
              style={{ display: "inline-block", marginTop: 10, color: "#b45cf0", fontSize: 14, fontWeight: 700 }}
            >
              View on HashScan →
            </a>
          </div>

          {healthLoading && (
            <p style={{ fontSize: 14, opacity: 0.7 }}>Checking the latest status…</p>
          )}
          {healthError && (
            <div style={{ ...card, border: "1px solid rgba(255,120,120,.4)", background: "rgba(255,80,80,.06)" }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Couldn't refresh this vault</div>
              <div style={{ fontSize: 14, opacity: 0.9 }}>{healthError}</div>
              <button onClick={loadHealth} style={{ ...ghostButton, marginTop: 12 }}>
                Try again
              </button>
            </div>
          )}

          {/* Recent activity */}
          <div style={{ margin: "4px 0 16px" }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Recent activity</div>
            {txns === null && <p style={{ fontSize: 14, opacity: 0.7 }}>Loading…</p>}
            {txns !== null && txns.length === 0 && (
              <p style={{ fontSize: 14, opacity: 0.7 }}>Nothing yet — this account hasn't done anything on-chain.</p>
            )}
            {txns !== null && txns.length > 0 && (
              <div style={{ display: "grid", gap: 8 }}>
                {txns.map((t) => (
                  <a
                    key={t.transaction_id}
                    href={hashscanTxUrl(t.transaction_id)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ ...card, marginBottom: 0, textDecoration: "none", color: "inherit", display: "block" }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontWeight: 700 }}>{friendlyTxnName(t.name)}</span>
                      <span style={{ fontSize: 13, opacity: 0.6 }}>{friendlyDate(t.consensus_timestamp)}</span>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div style={{ fontWeight: 800, marginBottom: 8 }}>Actions</div>

          {action.kind === "idle" && (
            <div style={{ display: "grid", gap: 8 }}>
              <button onClick={() => setAction({ kind: "confirm", what: "revoke" })} style={dangerButton}>
                Cut off the agent
              </button>
              <button onClick={() => setAction({ kind: "confirm", what: "sweep" })} style={ghostButton}>
                Sweep funds back to my wallet
              </button>
              <button
                onClick={() => setAction({ kind: "confirm", what: "update-form" })}
                style={ghostButton}
              >
                Sign as this account (update a blockpage it owns)
              </button>
            </div>
          )}

          {action.kind === "confirm" && action.what === "revoke" && (
            <div style={{ ...card, border: "1px solid rgba(255,120,120,.4)", background: "rgba(255,80,80,.06)" }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Cut off the agent?</div>
              <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9, marginBottom: 12 }}>
                This removes your agent's access immediately — the account goes back to your key
                only. Costs a few cents of gas. The funds stay in the account; sweep them after if
                you want them back.
              </div>
              <button onClick={doRevoke} style={{ ...dangerButton, marginBottom: 8 }}>
                Yes, cut them off
              </button>
              <button onClick={() => setAction({ kind: "idle" })} style={ghostButton}>
                Cancel
              </button>
            </div>
          )}

          {action.kind === "confirm" && action.what === "sweep" && (
            <div style={card}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Sweep the funds back?</div>
              <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9, marginBottom: 12 }}>
                This sends the account's HBAR back to your wallet, keeping a small cushion for
                network fees. Costs a few cents of gas.
              </div>
              <button onClick={doSweep} style={{ ...primaryButton, marginBottom: 8 }}>
                Yes, sweep the funds
              </button>
              <button onClick={() => setAction({ kind: "idle" })} style={ghostButton}>
                Cancel
              </button>
            </div>
          )}

          {action.kind === "confirm" && action.what === "update-form" && (
            <div style={card}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Sign as this account</div>
              <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9, marginBottom: 12 }}>
                Point a blockpage your spending account owns at new content. Paste the page's new
                IPFS link below — the update is signed by you and paid from the account's balance.
              </div>
              <label style={{ display: "block", fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
                Blockpage username
              </label>
              <input
                value={updateName}
                onChange={(e) => setUpdateName(e.target.value)}
                placeholder="myagent"
                autoCapitalize="none"
                autoCorrect="off"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "14px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,.2)",
                  background: "rgba(255,255,255,.06)",
                  color: "#f2ecff",
                  fontSize: 16,
                  marginBottom: 12,
                }}
              />
              <label style={{ display: "block", fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
                New IPFS link (CID)
              </label>
              <input
                value={updateCid}
                onChange={(e) => setUpdateCid(e.target.value)}
                placeholder="Qm… or bafy…"
                autoCapitalize="none"
                autoCorrect="off"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "14px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,.2)",
                  background: "rgba(255,255,255,.06)",
                  color: "#f2ecff",
                  fontSize: 16,
                  marginBottom: 12,
                }}
              />
              <button onClick={doPrepareUpdate} style={{ ...primaryButton, marginBottom: 8 }}>
                Prepare the update
              </button>
              <button onClick={() => setAction({ kind: "idle" })} style={ghostButton}>
                Cancel
              </button>
            </div>
          )}

          {action.kind === "confirm" && action.what === "update" && (
            <div style={card}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Ready to sign</div>
              <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9, marginBottom: 12 }}>
                {preparedUpdateNote ?? "This updates the blockpage's content. Costs a few cents of gas from the account."}
              </div>
              <button onClick={doSignUpdate} style={{ ...primaryButton, marginBottom: 8 }}>
                Sign it
              </button>
              <button onClick={() => setAction({ kind: "idle" })} style={ghostButton}>
                Cancel
              </button>
            </div>
          )}

          {action.kind === "working" && (
            <p style={{ fontSize: 15, lineHeight: 1.6, opacity: 0.85 }}>{action.what}</p>
          )}

          {action.kind === "done" && (
            <div style={{ ...card, border: "1px solid rgba(120,255,170,.35)", background: "rgba(80,255,150,.06)" }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Done</div>
              <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9, marginBottom: 10 }}>{action.what}</div>
              <a
                href={action.txUrl}
                target="_blank"
                rel="noreferrer"
                style={{ display: "inline-block", color: "#b45cf0", fontSize: 14, fontWeight: 700, marginRight: 18 }}
              >
                View receipt on HashScan →
              </a>
              <button onClick={() => setAction({ kind: "idle" })} style={{ ...ghostButton, marginTop: 10 }}>
                Back to actions
              </button>
            </div>
          )}

          {action.kind === "error" && (
            <div style={{ ...card, border: "1px solid rgba(255,120,120,.4)", background: "rgba(255,80,80,.06)" }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>That didn't go through</div>
              <div style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9, marginBottom: 12 }}>{action.what}</div>
              <button onClick={() => setAction({ kind: "idle" })} style={ghostButton}>
                Try again
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

export default function VaultManagePage() {
  return (
    <Suspense fallback={<main style={shell}><p>Loading…</p></main>}>
      <ManageInner />
    </Suspense>
  );
}
