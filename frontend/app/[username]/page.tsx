"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import PageRenderer, { type ServiceItem } from "@/components/PageRenderer";
import { useSession } from "@/lib/session";
import "@/components/renderer.css";
import { isValidPage, type RegistryMeta, type VoicescapePage } from "@/lib/schema";
import { getActiveChain } from "@/lib/chains";
import { resolvePage, tipPage } from "@/lib/contracts";
import { fetchPageJson } from "@/lib/ipfs";
import { friendlyWalletError, getHederaPairing, useWallet, WALLET_ADAPTERS } from "@/lib/wallet";
import { useConfirmedTransaction } from "@/hooks/useConfirmedTransaction";
import { useFundingGoal, TIP_CONFIRMED_EVENT } from "@/hooks/useFundingGoal";
import { WalletTimeoutError } from "@/lib/tx";
import { recordConversionEvent } from "@/lib/metrics";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import {
  buildTipProofUrl,
  buildTipShareIntentUrl,
  fillTipShareText,
} from "@/lib/tx-proof";
import { WalletConnect } from "@/components/WalletConnect";
import CommentWall from "@/components/townhall/CommentWall";
import DannyAgentCard from "@/components/DannyAgentCard";
import DannyLiaisonPanel from "@/components/DannyLiaisonPanel";
import PageBadges from "@/components/townhall/PageBadges";
import OnChainLiveBadge from "@/components/OnChainLiveBadge";
import { TxConfirming, TxReceipt, type TxReceiptLine } from "@/components/TxConfirm";
import ProfileLinks from "@/components/townhall/ProfileLinks";
import ReferralCard from "@/components/townhall/ReferralCard";
import ReportButton from "@/components/townhall/ReportButton";
import { IconBolt, IconCheck, IconClose, IconExternal, IconTip } from "@/components/icons";
import { ShareButtons } from "@/components/ShareButtons";
import {
  createWalletHederaSigner,
  formatUsdCents,
  getHbarUsdPrice,
  payX402,
  probeX402,
  type X402Rail,
} from "@/lib/x402";
import { usdToWei } from "@/lib/tokens";
import { AccountId } from "@hiero-ledger/sdk";
import { normalizeUsername } from "@/lib/identity";
import { canonicalAddress } from "@/lib/session-message";
import { TipPushToggle } from "@/components/TipPushToggle";
import TipCelebration from "@/components/TipCelebration";
import { EarningsPanel } from "@/components/EarningsPanel";
import { GoalBar } from "@/components/GoalBar";
import { FollowButton } from "@/components/FollowButton";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; page: VoicescapePage; meta: RegistryMeta };

const TIP_PRESETS_USD = ["0.10", "1", "5", "10", "25"];

function TipBox({
  username,
  paused,
  goalTargetHbar,
  onClose,
}: {
  username: string;
  /** True when the page's funding goal is reached: the tip form is replaced
   *  by an honest paused notice (covers the ?tip=1 deep link). */
  paused?: boolean;
  goalTargetHbar?: number | null;
  onClose: () => void;
}) {
  const { account, connect, getTxSender } = useWallet();
  const { session } = useSession();
  const { t } = useLanguage();
  const [usd, setUsd] = useState("5");
  const [hbarPrice, setHbarPrice] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [submittedHash, setSubmittedHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set once the wallet approves: the hook polls the mirror node until the
  // transaction reaches consensus, so the UI reacts to the real outcome
  // instead of sitting frozen on "Tipping…".
  const [confirmTxId, setConfirmTxId] = useState<string | null>(null);
  const confirmStatus = useConfirmedTransaction(confirmTxId);
  // Finality clock: wallet approval → consensus, shown on the receipt.
  const [approvedAt, setApprovedAt] = useState<number | null>(null);
  const [finalizedAt, setFinalizedAt] = useState<Date | null>(null);
  const [receiptLines, setReceiptLines] = useState<TxReceiptLine[]>([]);
  // HBAR string for the shareable receipt card (snapshotted with the lines).
  const [shareHbar, setShareHbar] = useState<string | null>(null);
  const chain = getActiveChain();

  // Mirror-node verdict landed — move to the matching end state.
  useEffect(() => {
    if (!confirmTxId) return;
    if (confirmStatus === "confirmed") {
      setFinalizedAt(new Date());
      setTxHash(confirmTxId);
      recordConversionEvent("tip_confirmed", "blockpage");
      // Nudge every funding-goal display on this page to refetch now.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(TIP_CONFIRMED_EVENT));
      }
    } else if (confirmStatus === "failed") {
      setError("The transaction failed on-chain. No tip was sent — check the explorer for details.");
      recordConversionEvent("tip_failed", "blockpage");
    } else if (confirmStatus === "timeout") {
      // Submitted but not yet visible (mirror lag). Money may have moved —
      // never claim failure; show the honest "submitted" state.
      setSubmittedHash(confirmTxId);
    }
  }, [confirmStatus, confirmTxId]);

  const resetTip = () => {
    setTxHash(null);
    setSubmittedHash(null);
    setConfirmTxId(null);
    setApprovedAt(null);
    setFinalizedAt(null);
    setReceiptLines([]);
    setShareHbar(null);
    setError(null);
  };

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
    // KISS: If the wallet state was lost (page reload) but the user has a
    // valid session, auto-reconnect with the session's wallet instead of
    // making them manually reconnect.
    let activeAccount = account;
    if (!activeAccount && session?.adapterId) {
      try {
        // The stored adapter must still be a supported one (e.g. a session
        // saved when MetaMask was offered is no longer connectable).
        const stored = WALLET_ADAPTERS.find((a) => a.id === session.adapterId);
        if (stored) activeAccount = await connect(stored.id);
      } catch {
        // connect() already sets wallet.error; fall through to the message below
      }
    }
    if (!activeAccount) {
      setError("Connect a wallet to tip.");
      return;
    }
    if (!usdValid) {
      setError("Enter a valid USD amount.");
      return;
    }
    setBusy(true);
    recordConversionEvent("tip_attempt", "blockpage");
    try {
      if (!hbarPrice) throw new Error("HBAR price is still loading — try again in a moment.");
      // Guardrail: never prompt a wallet signature for a doomed tip. The
      // contract reverts for unregistered pages — pre-check the registry
      // first so the user never signs a transaction that cannot succeed.
      const registered = await resolvePage(username, getActiveChain());
      if (!registered) throw new Error(`@${username} isn't registered on-chain — the tip would fail.`);
      const wei = usdToWei(usdNum, hbarPrice);
      const sender = await getTxSender();
      // Snapshot the breakdown for the success receipt — these amounts are
      // baked into the transaction, so they hold for every outcome path.
      const hbarAmt = usdNum / hbarPrice;
      setReceiptLines([
        { label: "You sent", value: `$${usdNum.toFixed(2)} (≈ ${hbarAmt.toFixed(4)} HBAR)` },
        { label: `${username} gets (98%)`, value: `≈ ${(hbarAmt * 0.98).toFixed(4)} HBAR` },
        { label: "Treasury gets (2%)", value: `≈ ${(hbarAmt * 0.02).toFixed(4)} HBAR` },
      ]);
      setShareHbar(hbarAmt.toFixed(4));
      const hash = await tipPage(username, wei, sender);
      // Approved — start the finality clock. The hook now confirms the real
      // on-chain outcome; the UI reacts (success / failed / submitted)
      // instead of freezing.
      setApprovedAt(Date.now());
      setConfirmTxId(hash);
    } catch (e) {
      if (e instanceof WalletTimeoutError) {
        // Wallet went silent after approval — don't guess. Confirm on-chain.
        setApprovedAt(Date.now());
        setConfirmTxId(e.txId);
      } else {
        // Wallet-side failure (rejection, wallet-library error, validation
        // guardrail): record the outcome so the funnel never shows a bare
        // attempt, and map known wallet-library TypeErrors to actionable
        // copy instead of the cryptic raw message.
        setError(`Tip failed: ${friendlyWalletError(e)}`);
        recordConversionEvent("tip_failed", "blockpage");
      }
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
        {paused ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span aria-hidden="true" style={{ fontSize: "1.6rem" }}>🎯</span>
              <h3 style={{ margin: 0 }}>{t("goal.pausedTitle")}</h3>
            </div>
            <p className="th-muted" style={{ lineHeight: 1.6, margin: "0 0 16px" }}>
              {t("goal.pausedBody").replace(
                "{target}",
                goalTargetHbar != null ? `${goalTargetHbar.toFixed(4)} HBAR` : "its goal",
              )}
            </p>
            <button type="button" className="pv-tip-btn" onClick={onClose}>
              {t("goal.pausedClose")}
            </button>
          </>
        ) : txHash ? (
          <>
            <TipCelebration
              usd={usdNum.toFixed(2)}
              hbar={shareHbar}
              username={username}
            />
            <TxReceipt
              title="Tip confirmed"
            approvedAt={approvedAt}
            finalizedAt={finalizedAt}
            txId={txHash}
            explorerBase={chain.blockExplorer}
            lines={receiptLines}
            nextStep={`It's live on @${username}'s page — they'll see your tip right away.`}
            onAgain={resetTip}
            onDone={onClose}
            proofHref={`/tx/${encodeURIComponent(txHash)}`}
            shareIntentUrl={
              shareHbar && typeof window !== "undefined"
                ? buildTipShareIntentUrl(
                    fillTipShareText(
                      t("receipt.shareTextTemplate"),
                      shareHbar,
                      username,
                      buildTipProofUrl(window.location.origin, txHash),
                    ),
                  )
                : undefined
            }
          />
          </>
        ) : submittedHash ? (
          <div className="pv-tip-confirm">
            <span className="pv-tip-confirm-icon" aria-hidden="true">
              <IconCheck size={30} />
            </span>
            <h3>Tip submitted</h3>
            <p>
              Your tip of ${usdValid ? usdNum.toFixed(2) : "?"} ({railDisplay}) was sent to {username}.
              It&apos;s still being confirmed on-chain — check the explorer in a minute to see it land.
            </p>
            <span className="pv-tx-hash vs-mono">{submittedHash}</span>
            <br />
            <a
              className="pv-tx-link"
              href={`${chain.blockExplorer}/transaction/${submittedHash}`}
              target="_blank"
              rel="noreferrer"
            >
              View on explorer <IconExternal size={14} />
            </a>
            <button type="button" className="pv-tip-again" onClick={resetTip}>
              Tip again
            </button>
            <button
              type="button"
              className="vs-btn vs-btn-ghost"
              style={{ marginTop: 8 }}
              onClick={onClose}
            >
              Done
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

            <div className="pv-pay-price-note" aria-live="polite" style={{ textAlign: "center", marginBottom: 8 }}>
              You send {railDisplay}
            </div>

            {hbarPrice && usdValid && (
              <div style={{ fontSize: 12, color: "var(--vs-muted)", textAlign: "center", marginBottom: 14, lineHeight: 1.6 }}>
                <div>Creator gets ≈ {((usdNum / hbarPrice) * 0.98).toFixed(4)} HBAR (98%)</div>
                <div>Treasury gets ≈ {((usdNum / hbarPrice) * 0.02).toFixed(4)} HBAR (2%)</div>
                <div>Network fee ≈ 0.08 HBAR (paid to Hedera, not Voicescape)</div>
              </div>
            )}

            <button type="button" className="pv-tip-btn" onClick={tip} disabled={busy || confirmStatus === "confirming" || !hbarPrice}>
              <IconTip size={20} />
              {confirmStatus === "confirming" ? "Confirming on Hedera…" : busy ? "Tipping…" : !hbarPrice ? "Loading price…" : `Tip $${usdValid ? usdNum.toFixed(2) : "0.00"}`}
            </button>
            {/* Phase A: wallet hasn't returned a hash yet — nothing has left
                the wallet. Alive animation + the honest reassurance, never
                a dead "Tipping…". */}
            {busy && !confirmTxId && (
              <TxConfirming
                title="Waiting on your wallet…"
                sub="Waiting for your wallet to return the transaction. Keep this page open. If you already approved, Voicescape will keep checking for the result."
              />
            )}
            {/* Phase B: hash in hand, polling for consensus — show the
                in-flight transaction as proof so the wait never feels
                like the money vanished. */}
            {confirmStatus === "confirming" && (
              <TxConfirming
                sub="Approved in your wallet — waiting for Hedera to reach consensus (usually a few seconds)."
                txId={confirmTxId}
                explorerBase={chain.blockExplorer}
              />
            )}

            <p className="pv-fee-note">
              98% to the creator · 2% to the treasury — enforced on-chain
            </p>

            {error && (
              <div className="pv-tip-error">
                {error}
                <div style={{ marginTop: 8 }}>
                  <a
                    href="https://discord.gg/2KGzPduUN5"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Need help? Get support on Discord →
                  </a>
                </div>
              </div>
            )}
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
        const { Transaction } = await import("@hiero-ledger/sdk");
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
  // Deep link from the fundraiser board: /<username>?tip=1 opens the tip box
  // so a donation is one tap from the campaign card. ?goal=1 scrolls to the
  // funding-goal setter so starting a fundraiser is one tap, not a hunt.
  let autoTip = false;
  let autoGoal = false;
  try {
    const sp = useSearchParams();
    autoTip = sp.get("tip") === "1";
    autoGoal = sp.get("goal") === "1";
  } catch {
    autoTip = false;
    autoGoal = false;
  }
  useEffect(() => {
    if (autoTip) setTipOpen(true);
  }, [autoTip]);
  // Session may be absent outside the root providers; degrade gracefully.
  let viewerAddress: string | undefined;
  try {
    viewerAddress = useSession().session?.address ?? undefined;
  } catch {
    viewerAddress = undefined;
  }
  // Fundraiser pause: when the owner's funding goal is reached, the tip
  // flow pauses with honest messaging (the owner reopens it by setting a
  // new goal). Derived from the same on-chain raised total as <GoalBar>.
  const goalOwner =
    state.status === "ready" ? canonicalAddress(state.meta.owner) : null;
  const { reached: goalReached, goal: fundingGoal } = useFundingGoal(username, goalOwner);

  // Owner view: the connected wallet matches the page's on-chain owner
  // (compared in canonical EVM form — the session may be 0.0.x or 0x…).
  // The tip-notifications toggle renders ONLY for the owner.
  const isOwner =
    state.status === "ready" &&
    !!viewerAddress &&
    (() => {
      const a = canonicalAddress(viewerAddress as string);
      const b = canonicalAddress(state.meta.owner);
      return !!a && !!b && a === b;
    })();

  useEffect(() => {
    // The goal form lives in the owner-only EarningsPanel below the fold;
    // scroll straight to it once the page data has rendered AND ownership
    // has resolved. The session (hence isOwner) can restore after the page
    // data — e.g. HashPack's in-app auto-connect — so retry briefly until
    // the element exists instead of firing once and silently missing.
    if (!autoGoal || state.status !== "ready" || !isOwner) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryScroll = () => {
      const el = document.getElementById("set-funding-goal");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (attempts++ < 10) timer = setTimeout(tryScroll, 250);
    };
    tryScroll();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [autoGoal, state.status, isOwner]);

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
        // no-store: never serve a cached 404 after the API is fixed
        const res = await fetch(`/api/resolve?username=${encodeURIComponent(username)}`, {
          cache: "no-store",
        });
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

  // EVM form of the page owner for the on-chain earnings APIs.
  const ownerEvm = canonicalAddress(state.meta.owner);

  return (
    <>
      <OnChainLiveBadge owner={state.meta.owner} />
      <PageRenderer
        page={state.page}
        meta={state.meta}
        tipInteractive
        onTip={() => setTipOpen((v) => !v)}
        tipPaused={goalReached}
        onPayService={setService}
        // Canonical identity: the route username, which only renders after
        // /api/resolve confirms the on-chain registration. The Founder badge
        // is gated on this — never on the IPFS page JSON.
        canonicalUsername={username}
      />
      {tipOpen && (
        <TipBox
          username={username}
          paused={goalReached}
          goalTargetHbar={fundingGoal?.targetHbar ?? null}
          onClose={() => setTipOpen(false)}
        />
      )}
      {service && <ServicePayModal service={service} onClose={() => setService(null)} />}
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "0 18px 72px" }}>
        {/* danny's blockpage shows the liaison's live A2A agent card, fetched
            from /.well-known/agent.json — the same document machines read.
            danny-only: no other agent publishes a card on this domain. */}
        {username === "danny" && <DannyAgentCard />}
        {/* Liaison slice-1: paid human-facing help — chat, tip-to-unlock,
            and wallet-bound blockpage drafts. Danny-only, like the agent card. */}
        {username === "danny" && <DannyLiaisonPanel />}
        {ownerEvm && <GoalBar username={username} ownerAddress={ownerEvm} />}
        {isOwner && <TipPushToggle wallet={state.meta.owner} />}
        {isOwner && ownerEvm && (
          <EarningsPanel username={username} ownerAddress={ownerEvm} ownerType={state.meta.ownerType} />
        )}
        <ShareButtons username={username} />
        {!isOwner && <FollowButton username={username} />}
        <PageBadges username={username} wallet={state.meta.owner} />
        <ProfileLinks username={username} />
        <ReferralCard username={username} />
        <div style={{ marginTop: 16, textAlign: "center" }}>
          <span className="th-muted" style={{ fontSize: "0.85rem", marginRight: 4 }}>
            Something wrong with this blockpage?
          </span>
          <ReportButton targetKind="profile" targetId={username} />
        </div>
        {/* Agent pages only: one quiet findability line for crawlers and
            developers pointing at the machine-readable A2A agent card.
            Renders from registry metadata — never from editable page content. */}
        {state.meta.ownerType === "agent" && (
          <div style={{ marginTop: 16, textAlign: "center" }}>
            <a
              href="/.well-known/agent.json"
              className="th-muted"
              style={{ fontSize: "0.8rem" }}
            >
              Machine-readable agent card
            </a>
          </div>
        )}
        <CommentWall username={username} owner={state.meta.owner} />
      </div>
    </>
  );
}

export default function PublicPage({ params }: { params: { username: string } }) {
  const { username } = params;
  // KISS identity: /0.0.10424063 resolves to the wallet's derived page
  // (user-10424063) so users can share either form.
  // KISS: No nested WalletProvider — the root layout already provides it.
  // A nested provider causes split wallet state (the wrong-account bug).
  // Suspense boundary: PublicPageInner reads useSearchParams (?tip=1).
  return (
    <Suspense>
      <PublicPageInner username={normalizeUsername(username)} />
    </Suspense>
  );
}
