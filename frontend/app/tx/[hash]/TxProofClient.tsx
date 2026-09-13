"use client";

/**
 * <TxProofClient> — the split explorer UI for /tx/[hash].
 *
 * Fetches the transaction from the Hedera mirror node, verifies it is a
 * successful call to the Tips contract (0.0.10854060), decodes the TipSent
 * event's (gross, fee) words, and renders the split as PUBLIC PROOF.
 * Anything else — wrong contract, reverted tx, missing event, mirror
 * outage, garbage id — renders an honest error state, never a fabricated
 * split.
 *
 * Usernames come from the existing /api/resolve?owner= reverse lookup;
 * unresolved addresses fall back to a shortened 0x… form.
 */
import { useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { WalletConnect } from "@/components/WalletConnect";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import type { I18nKey } from "@/lib/i18n/dictionaries";
import { IconCheck, IconExternal } from "@/components/icons";
import {
  fetchTipProof,
  tinybarToHbar,
  shortAddress,
  HASHSCAN_TX_BASE,
  type TipProof,
  type ProofErrorKind,
} from "@/lib/tx-proof";

const ERROR_KEYS: Record<ProofErrorKind, I18nKey> = {
  malformed: "txproof.errMalformed",
  "not-found": "txproof.errNotFound",
  "not-a-tip": "txproof.errNotTip",
  reverted: "txproof.errReverted",
  network: "txproof.errNetwork",
  decode: "txproof.errDecode",
};

type State =
  | { status: "loading" }
  | { status: "error"; kind: ProofErrorKind }
  | {
      status: "ready";
      proof: TipProof;
      senderName: string | null;
      recipientName: string | null;
    };

/** Reverse-lookup a registered page username for an EVM address. Null when none. */
async function resolveUsername(address: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/resolve?owner=${encodeURIComponent(address)}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { username?: unknown };
    return typeof data.username === "string" ? data.username : null;
  } catch {
    return null;
  }
}

function formatConsensus(ts: string): string {
  const sec = Number(ts.split(".")[0]);
  if (!Number.isFinite(sec) || sec <= 0) return ts;
  return new Date(sec * 1000).toLocaleString();
}

function PartyLabel({ address, username }: { address: string; username: string | null }) {
  if (username) {
    return (
      <span>
        <strong>@{username}</strong>{" "}
        <span className="vs-mono" style={{ fontSize: 12, color: "var(--vs-muted)" }}>
          {shortAddress(address)}
        </span>
      </span>
    );
  }
  return <span className="vs-mono">{shortAddress(address)}</span>;
}

export default function TxProofClient({ hash }: { hash: string }) {
  const { t } = useLanguage();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let live = true;
    (async () => {
      const result = await fetchTipProof(hash);
      if (!live) return;
      if (!result.ok) {
        setState({ status: "error", kind: result.error });
        return;
      }
      const [senderName, recipientName] = await Promise.all([
        resolveUsername(result.proof.sender),
        resolveUsername(result.proof.recipient),
      ]);
      if (!live) return;
      setState({ status: "ready", proof: result.proof, senderName, recipientName });
    })();
    return () => {
      live = false;
    };
  }, [hash]);

  const rows: { label: string; value: React.ReactNode }[] =
    state.status === "ready"
      ? [
          {
            label: t("txproof.sender"),
            value: <PartyLabel address={state.proof.sender} username={state.senderName} />,
          },
          {
            label: t("txproof.recipient"),
            value: <PartyLabel address={state.proof.recipient} username={state.recipientName} />,
          },
          {
            label: t("txproof.gross"),
            value: <strong>{tinybarToHbar(state.proof.grossTinybar)} HBAR</strong>,
          },
          {
            label: t("txproof.creator"),
            value: <strong>{tinybarToHbar(state.proof.creatorTinybar)} HBAR</strong>,
          },
          {
            label: t("txproof.fee"),
            value: <strong>{tinybarToHbar(state.proof.feeTinybar)} HBAR</strong>,
          },
          ...(state.proof.consensusTimestamp
            ? [
                {
                  label: t("txproof.timestamp"),
                  value: formatConsensus(state.proof.consensusTimestamp),
                },
              ]
            : []),
        ]
      : [];

  return (
    <>
      <Navbar right={<WalletConnect />} />
      <main className="vs-section" style={{ maxWidth: 720, margin: "0 auto" }}>
        <p className="vs-label" style={{ textAlign: "center" }}>
          {t("txproof.kicker")}
        </p>
        <h1 style={{ textAlign: "center", fontSize: "clamp(1.5rem, 4vw, 2.2rem)", margin: "12px 0 28px" }}>
          {t("txproof.title")}
        </h1>

        {state.status === "loading" && (
          <div className="vs-glass" style={{ padding: 40, textAlign: "center" }} role="status">
            <p style={{ margin: 0, color: "var(--vs-muted)" }}>{t("txproof.loading")}</p>
          </div>
        )}

        {state.status === "error" && (
          <div
            className="vs-glass"
            style={{ padding: 40, textAlign: "center" }}
            role="alert"
          >
            <p style={{ margin: "0 0 8px", fontSize: 16 }}>{t(ERROR_KEYS[state.kind])}</p>
            <p className="vs-mono" style={{ fontSize: 12, color: "var(--vs-muted)", wordBreak: "break-all", margin: 0 }}>
              {hash}
            </p>
          </div>
        )}

        {state.status === "ready" && (
          <div className="vs-glass" style={{ padding: 28 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 20,
                color: "var(--vs-cyan)",
                fontWeight: 700,
              }}
            >
              <IconCheck size={22} />
              <span>
                {state.proof.splitExact ? t("txproof.exact") : t("txproof.title")}
              </span>
            </div>
            <div className="tx-rows" aria-label={t("txproof.title")}>
              {rows.map((r) => (
                <div className="tx-row" key={r.label}>
                  <span>{r.label}</span>
                  <span style={{ textAlign: "right" }}>{r.value}</span>
                </div>
              ))}
            </div>
            <a
              className="vs-btn vs-btn-primary tx-hashscan"
              href={`${HASHSCAN_TX_BASE}/${state.proof.txId}`}
              target="_blank"
              rel="noreferrer"
            >
              {t("txproof.hashscan")} <IconExternal size={14} />
            </a>
            <p className="vs-mono tx-txid">{state.proof.txId}</p>
          </div>
        )}
      </main>
    </>
  );
}
