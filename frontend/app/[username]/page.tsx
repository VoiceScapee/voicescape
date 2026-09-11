"use client";

import { useEffect, useState } from "react";
import PageRenderer, { type ServiceItem } from "@/components/PageRenderer";
import { useSession } from "@/lib/session";
import "@/components/renderer.css";
import { isValidPage, type RegistryMeta, type VoicescapePage } from "@/lib/schema";
import { getActiveChain } from "@/lib/chains";
import { resolvePage, tipPage } from "@/lib/contracts";
import { fetchPageJson } from "@/lib/ipfs";
import { WalletProvider, getHederaPairing, useWallet } from "@/lib/wallet";
import { WalletConnect } from "@/components/WalletConnect";
import CommentWall from "@/components/townhall/CommentWall";
import PageBadges from "@/components/townhall/PageBadges";
import ProfileLinks from "@/components/townhall/ProfileLinks";
import ReferralCard from "@/components/townhall/ReferralCard";
import ReportButton from "@/components/townhall/ReportButton";
import { IconBolt, IconCheck, IconClose, IconExternal, IconTip } from "@/components/icons";
import {
  createWalletHederaSigner,
  formatUsdCents,
  getHbarUsdPrice,
  payX402,
  probeX402,
  type X402Rail,
} from "@/lib/x402";
import { usdToWei } from "@/lib/tokens";
import { AccountId } from "@hashgraph/sdk";
import { normalizeUsername } from "@/lib/identity";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; page: VoicescapePage; meta: RegistryMeta };

const TIP_PRESETS_USD = ["1", "5", "10", "25"];

function TipBox({
  username,
  onClose,
}: {
  username: string;
  onClose: () => void;
}) {
  const { account, getTxSender } = useWallet();
  const [usd, setUsd] = useState("5");
  const [hbarPrice, setHbarPrice] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chain = getActiveChain();

  useEffect(() => {
    getHbarUsdPrice().then(setHbarPrice).catch(() => setHbarPrice(null));
  }, []);

  const usdNum = Number(usd);
  const usdValid = Number.isFinite(usdNum) && usdNum > 0;
  // Display conversion (USD terms are primary). Tips are HBAR-only, routed
  // through the on-chain tips contract (98/2 split).
  const railDisplay =
    hbarPrice && usdValid
      ? `≈ ${(usdNum / hbarPrice).toFixed(4)} ${chain.nativeCurrency.symbol}`
      : `${chain.nativeCurrency.symbol} amount loading…`;

  const tip = async () => {
    setError(null);
    if (!account) {
      setError("Connect a wallet to tip.");
      return;
    }
    if (!usdValid) {
      setError("Enter a valid USD amount.");
      return;
    }
    setBusy(true);
    try {
      if (!hbarPrice) throw new Error("HBAR price is still loading — try again in a moment.");
      const wei = usdToWei(usdNum, hbarPrice);
      const sender = await getTxSender();
      const hash = await tipPage(username, wei, sender);
      setTxHash(hash);
    } catch (e) {
      setError(`Tip failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="pv-tip-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Tip ${username}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="pv-tip-card">
        {txHash ? (
          <div className="pv-tip-confirm">
            <span className="pv-tip-confirm-icon" aria-hidden="true">
              <IconCheck size={30} />
            </span>
            <h3>Tip confirmed</h3>
            <p>
              ${usdValid ? usdNum.toFixed(2) : "?"} ({railDisplay}) sent to {username}
              {" — 98% to the creator, 2% to the treasury (enforced on-chain)."}
            </p>
            <span className="pv-tx-hash vs-mono">{txHash}</span>
            <br />
            <a
              className="pv-tx-link"
              href={`${chain.blockExplorer}/transaction/${txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              View on explorer <IconExternal size={14} />
            </a>
            <button type="button" className="pv-tip-again" onClick={() => setTxHash(null)}>
              Tip again
            </button>
          </div>
        ) : (
          <>
            <div className="pv-tip-head">
              <h2 className="pv-tip-title">
                <span className="pv-tip-title-icon" aria-hidden="true">
                  <IconTip size={20} />
                </span>
                Tip {username}
              </h2>
              <button type="button" className="pv-tip-close" onClick={onClose} aria-label="Close tip panel">
                <IconClose size={18} />
              </button>
            </div>
            <p className="pv-tip-sub">
              Send a tip directly on-chain. Amounts are shown in USD.
            </p>

            <WalletConnect />

            <div className="pv-tip-amount" aria-live="polite">
              <span className="pv-tip-amount-value">${usdValid ? usdNum.toFixed(2) : "0.00"}</span>
              <span className="pv-tip-amount-sym">USD</span>
            </div>

            <div className="pv-chip-row" role="group" aria-label="Tip amount presets (USD)">
              {TIP_PRESETS_USD.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`pv-chip${usd === p ? " is-active" : ""}`}
                  onClick={() => setUsd(p)}
                >
                  ${p}
                </button>
              ))}
            </div>
            <input
              className="pv-tip-input"
              value={usd}
              onChange={(e) => setUsd(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="Custom USD amount"
              aria-label="Custom tip amount in USD"
            />

            <div className="pv-pay-price-note" aria-live="polite" style={{ textAlign: "center", marginBottom: 14 }}>
              You send {railDisplay}
            </div>

            <button type="button" className="pv-tip-btn" onClick={tip} disabled={busy}>
              <IconTip size={20} />
              {busy ? "Tipping…" : `Tip $${usdValid ? usdNum.toFixed(2) : "0.00"}`}
            </button>

            <p className="pv-fee-note">
              98% to the creator · 2% to the treasury — enforced on-chain
            </p>

            {error && <div className="pv-tip-error">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pay-per-call modal for agent service listings                       */
/* ------------------------------------------------------------------ */

type PayPhase =
  | { kind: "probing" }
  | { kind: "choose"; rails: X402Rail[]; description?: string }
  | { kind: "paying" }
  | { kind: "done"; body: string; settleTxId: string | null }
  | { kind: "error"; message: string };

function ServicePayModal({ service, onClose }: { service: ServiceItem; onClose: () => void }) {
  const [phase, setPhase] = useState<PayPhase>({ kind: "probing" });
  const [rail, setRail] = useState<X402Rail | null>(null);
  const [params, setParams] = useState("{}");
  const chain = getActiveChain();

  useEffect(() => {
    let cancelled = false;
    probeX402(service.endpoint)
      .then((probe) => {
        if (cancelled) return;
        setRail(probe.rails[0] ?? null);
        setPhase({ kind: "choose", rails: probe.rails, description: probe.description });
      })
      .catch((e) => {
        if (!cancelled) setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [service.endpoint]);

  const pay = async () => {
    if (!rail) return;
    setPhase({ kind: "paying" });
    try {
      let body: unknown = {};
      try {
        body = params.trim() ? JSON.parse(params) : {};
      } catch {
        throw new Error("Request params are not valid JSON.");
      }
      const pairing = getHederaPairing();
      if (!pairing) throw new Error("Connect a Hedera wallet (HashPack / Blade / WalletConnect) to pay.");
      const { getActiveChain: getChain } = await import("@/lib/chains");
      const activeChain = getChain();
      const network = activeChain.key === "hedera-mainnet" ? "mainnet" : "testnet";
      const signer = createWalletHederaSigner(pairing.accountId, async (tx) => {
        // Serialize to base64 — avoids hiero-sdk/hashgraph-sdk type friction.
        const txBytes = tx.toBytes();
        let binary = "";
        txBytes.forEach((b) => { binary += String.fromCharCode(b); });
        const txB64 = btoa(binary);
        const result = await (pairing.hc.signTransaction as unknown as (params: object) => Promise<unknown>)({
          signerAccountId: `hedera:${network}:${pairing.accountId}`,
          transactionBody: txB64,
        });
        const { Transaction } = await import("@hashgraph/sdk");
        if (result instanceof Transaction) {
          return result;
        }
        throw new Error("Wallet did not return a signed transaction.");
      });
      const { response, settleTxId } = await payX402(
        service.endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        rail,
        signer,
      );
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Service returned ${response.status}: ${text.slice(0, 300)}`);
      }
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // keep raw text
      }
      setPhase({ kind: "done", body: pretty, settleTxId });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div
      className="pv-tip-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Pay for ${service.name}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="pv-pay-modal">
        <div className="pv-tip-head">
          <h2 className="pv-tip-title">
            <span className="pv-tip-title-icon" aria-hidden="true">
              <IconBolt size={20} />
            </span>
            {service.name}
          </h2>
          <button type="button" className="pv-tip-close" onClick={onClose} aria-label="Close payment panel">
            <IconClose size={18} />
          </button>
        </div>
        {service.description && <p className="pv-tip-sub">{service.description}</p>}

        <div className="pv-pay-price">
          <div className="pv-pay-price-usd">${(service.priceUsdCents / 100).toFixed(2)}</div>
          <div className="pv-pay-price-note">per call · paid via x402, no account needed</div>
        </div>

        <WalletConnect />

        {phase.kind === "probing" && (
          <p className="pv-pay-status">Reading the service&apos;s payment terms (402)…</p>
        )}

        {(phase.kind === "choose" || phase.kind === "paying") && (
          <>
            <div className="pv-rail-row" role="group" aria-label="Payment rail">
              {phase.kind === "choose"
                ? phase.rails.map((r) => (
                    <button
                      key={`${r.network}:${r.asset}`}
                      type="button"
                      className={`pv-rail-btn${rail?.asset === r.asset && rail?.network === r.network ? " is-active" : ""}`}
                      onClick={() => setRail(r)}
                    >
                      <span className="pv-rail-name">{r.label}</span>
                      <span className="pv-rail-amt">
                        {r.amountDisplay} · {formatUsdCents(r.usdCents)}
                      </span>
                    </button>
                  ))
                : null}
            </div>
            <label className="vs-label" htmlFor="pv-pay-params">
              Request body (JSON)
            </label>
            <textarea
              id="pv-pay-params"
              className="pv-pay-params"
              value={params}
              onChange={(e) => setParams(e.target.value)}
              spellCheck={false}
            />
            <button type="button" className="pv-tip-btn" onClick={pay} disabled={phase.kind !== "choose" || !rail}>
              <IconBolt size={20} />
              {phase.kind === "paying"
                ? "Paying in wallet…"
                : rail
                  ? `Pay ${rail.amountDisplay} & call`
                  : "Pay & call"}
            </button>
            <p className="pv-pay-status">
              Your wallet signs one {rail?.label ?? ""} transfer to the service. The facilitator settles it
              on-chain, then the service runs. Prices marked ≈ use an approximate HBAR/USD rate — the
              402&apos;s advertised amount is what you actually pay.
            </p>
          </>
        )}

        {phase.kind === "done" && (
          <div className="pv-pay-result">
            <div className="pv-pay-status is-ok">✅ Payment settled{phase.settleTxId ? " — service responded:" : " — service responded:"}</div>
            {phase.settleTxId && (
              <a
                className="pv-review-tx vs-mono"
                href={`${chain.blockExplorer}/transaction/${phase.settleTxId}`}
                target="_blank"
                rel="noreferrer"
              >
                <IconExternal size={13} /> settle tx {phase.settleTxId.slice(0, 24)}…
              </a>
            )}
            <pre>{phase.body}</pre>
          </div>
        )}

        {phase.kind === "error" && (
          <div className="pv-pay-status is-err">❌ {phase.message}</div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Public page                                                         */
/* ------------------------------------------------------------------ */

function PublicPageInner({ username }: { username: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [tipOpen, setTipOpen] = useState(false);
  const [service, setService] = useState<ServiceItem | null>(null);
  // Session may be absent outside the root providers; degrade gracefully.
  let viewerAddress: string | undefined;
  try {
    viewerAddress = useSession().session?.address ?? undefined;
  } catch {
    viewerAddress = undefined;
  }

  // Fire-and-forget view tracking for creator analytics. Never blocks the
  // page; the server rate-limits per IP and skips the owner's own views.
  useEffect(() => {
    const name = username.trim().toLowerCase();
    if (!name) return;
    fetch("/api/analytics/view", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, viewerAddress }),
      keepalive: true,
    }).catch(() => {
      /* analytics must never break the page */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // Use server-side API to avoid browser CORS issues with Hedera RPC
        const res = await fetch(`/api/resolve?username=${encodeURIComponent(username)}`);
        if (!res.ok) {
          if (!cancelled) setState({ status: "not-found" });
          return;
        }
        const resolved = await res.json();
        const json = await fetchPageJson(resolved.ipfsHash);
        const parsed: unknown = JSON.parse(json);
        if (!isValidPage(parsed)) throw new Error("Page JSON does not match the schema.");
        const meta: RegistryMeta = {
          owner: resolved.owner,
          ownerType: resolved.ownerType === 1 ? "agent" : "human",
          operator: resolved.operator,
          purpose: resolved.purpose,
        };
        if (!cancelled) setState({ status: "ready", page: parsed, meta });
      } catch (e) {
        if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [username]);

  if (state.status === "loading") {
    return (
      <div className="pv-state" aria-live="polite">
        <div className="pv-shimmer-bar" />
        <div className="pv-shimmer-bar" style={{ width: "min(280px, 60vw)" }} />
        <p className="pv-loading-text">
          Resolving <span className="vs-mono">{username}</span>… on-chain
        </p>
      </div>
    );
  }
  if (state.status === "not-found") {
    return (
      <div className="pv-state">
        <div className="pv-state-code">404</div>
        <h1>Page not found</h1>
        <p>
          No Voicescape page is registered for <span className="vs-mono">{username}</span>.
        </p>
        <a className="pv-state-link" href="/builder">
          Create it in the builder
        </a>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="pv-state">
        <div className="pv-state-code">!</div>
        <h1>Couldn&apos;t load this page</h1>
        <p>{state.message}</p>
        <a className="pv-state-link" href="/builder">
          Go to the builder
        </a>
      </div>
    );
  }

  return (
    <>
      <PageRenderer
        page={state.page}
        meta={state.meta}
        tipInteractive
        onTip={() => setTipOpen((v) => !v)}
        onPayService={setService}
      />
      {tipOpen && (
        <TipBox username={username} onClose={() => setTipOpen(false)} />
      )}
      {service && <ServicePayModal service={service} onClose={() => setService(null)} />}
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "0 18px 72px" }}>
        <PageBadges username={username} wallet={state.meta.owner} />
        <ProfileLinks username={username} />
        <ReferralCard username={username} />
        <div style={{ marginTop: 16, textAlign: "center" }}>
          <span className="th-muted" style={{ fontSize: "0.85rem", marginRight: 4 }}>
            Something wrong with this page?
          </span>
          <ReportButton targetKind="profile" targetId={username} />
        </div>
        <CommentWall username={username} owner={state.meta.owner} />
      </div>
    </>
  );
}

export default function PublicPage({ params }: { params: { username: string } }) {
  const { username } = params;
  // KISS identity: /0.0.10424063 resolves to the wallet's derived page
  // (user-10424063) so users can share either form.
  return (
    <WalletProvider>
      <PublicPageInner username={normalizeUsername(username)} />
    </WalletProvider>
  );
}
