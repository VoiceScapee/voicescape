"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
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
import { markClaimCongratsSeen, readClaimCongrats } from "@/lib/claim-congrats";
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
import { usdToWei, hbarToWei } from "@/lib/tokens";
import {
  TIP_CURRENCY_KEY,
  TIP_PANEL_EVENT,
  normalizeTipInput,
  readTipCurrency,
  type TipCurrency,
} from "@/lib/tip-currency";
import { AccountId } from "@hiero-ledger/sdk";
import { normalizeUsername } from "@/lib/identity";
import { canonicalAddress } from "@/lib/session-message";
import { TipPushToggle } from "@/components/TipPushToggle";
import TipCelebration from "@/components/TipCelebration";
import TaxNotice from "@/components/TaxNotice";
import { EarningsPanel } from "@/components/EarningsPanel";
import { GoalBar } from "@/components/GoalBar";
import { FollowButton } from "@/components/FollowButton";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; page: VoicescapePage; meta: RegistryMeta };

const TIP_PRESETS_USD = ["0.10", "1", "5", "10", "25"];
const TIP_PRESETS_HBAR = ["1", "5", "10", "25", "50"];

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
  // Visitor-chosen tip currency: USD (converted to HBAR at send time) or
  // HBAR directly (exact amounts, no price feed needed).
  const [currency, setCurrency] = useState<TipCurrency>(() =>
    typeof window !== "undefined" ? readTipCurrency() : "usd",
  );
  const [hbarInput, setHbarInput] = useState("5");
  const isHbar = currency === "hbar";
  useEffect(() => {
    try {
      window.localStorage.setItem(TIP_CURRENCY_KEY, currency);
    } catch {
      // Private mode etc. — the toggle still works for this visit.
    }
  }, [currency]);
  // Let the floating Buddy button hide while the tip panel is open.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(TIP_PANEL_EVENT, { detail: true }));
    return () => {
      window.dispatchEvent(new CustomEvent(TIP_PANEL_EVENT, { detail: false }));
    };
  }, []);
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
  const hbarNum = Number(hbarInput);
  const hbarValid = Number.isFinite(hbarNum) && hbarNum > 0;
  // Display conversion (USD terms are primary). Tips are HBAR-only, routed
  // through the on-chain tips contract (98/2 split).
  const railDisplay =
    hbarPrice && usdValid
      ? `≈ ${(usdNum / hbarPrice).toFixed(4)} ${chain.nativeCurrency.symbol}`
      : `${chain.nativeCurrency.symbol} amount loading…`;

  // Breakdown math for the plain-words 98/2 panel. In HBAR mode the amount
  // is exact; in USD mode it's valid only when the HBAR price has loaded
  // and the USD amount parses.
  const hbarAmt = isHbar
    ? hbarValid
      ? hbarNum
      : null
    : hbarPrice && usdValid
      ? usdNum / hbarPrice
      : null;
  // Label for the "submitted" state, in the visitor's chosen currency.
  const tipSentLabel = isHbar
    ? hbarValid
      ? `${hbarInput} HBAR`
      : "?"
    : `$${usdValid ? usdNum.toFixed(2) : "?"}`;
  const toCreatorAmt = hbarAmt != null ? hbarAmt * 0.98 : null;
  const treasuryAmt = hbarAmt != null ? hbarAmt * 0.02 : null;
  // Short display ("5" not "5.00") for the plain-words breakdown note.
  const fmtHbarShort = (n: number) => String(Math.round(n * 100) / 100);
  // Hedera-side network fee (existing display value), passed through the
  // i18n placeholder rather than hard-coded into JSX copy.
  const NETWORK_FEE_HBAR = "0.08";

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
    if (isHbar) {
      if (!hbarValid) {
        setError("Enter a valid HBAR amount.");
        return;
      }
    } else {
      if (!usdValid) {
        setError("Enter a valid USD amount.");
        return;
      }
    }
    setBusy(true);
    recordConversionEvent("tip_attempt", "blockpage");
    try {
      // USD mode needs the price feed to convert; HBAR mode is exact.
      const price = isHbar ? null : hbarPrice;
      if (!isHbar && !price) throw new Error("HBAR price is still loading — try again in a moment.");
      // Guardrail: never prompt a wallet signature for a doomed tip. The
      // contract reverts for unregistered pages — pre-check the registry
      // first so the user never signs a transaction that cannot succeed.
      const registered = await resolvePage(username, getActiveChain());
      if (!registered) throw new Error(`@${username} isn't registered on-chain — the tip would fail.`);
      const sendHbar = isHbar ? hbarNum : usdNum / (price as number);
      const wei = isHbar ? hbarToWei(hbarNum) : usdToWei(usdNum, price as number);
      const sender = await getTxSender();
      // Snapshot the breakdown for the success receipt — these amounts are
      // baked into the transaction, so they hold for every outcome path.
      setReceiptLines(
        isHbar
          ? [
              { label: "You sent", value: `${hbarNum} HBAR` },
              { label: `${username} gets (98%)`, value: `${(sendHbar * 0.98).toFixed(4)} HBAR` },
              { label: "Treasury gets (2%)", value: `${(sendHbar * 0.02).toFixed(4)} HBAR` },
            ]
          : [
              { label: "You sent", value: `$${usdNum.toFixed(2)} (≈ ${sendHbar.toFixed(4)} HBAR)` },
              { label: `${username} gets (98%)`, value: `≈ ${(sendHbar * 0.98).toFixed(4)} HBAR` },
              { label: "Treasury gets (2%)", value: `≈ ${(sendHbar * 0.02).toFixed(4)} HBAR` },
            ],
      );
      setShareHbar(sendHbar.toFixed(4));
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
              usd={isHbar ? `${hbarInput} HBAR` : `$${usdNum.toFixed(2)}`}
              hbar={isHbar ? null : shareHbar}
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
              Your tip of {tipSentLabel}
              {!isHbar && <> ({railDisplay})</>} was sent to {username}.
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
                {t("tip.titleFor").replace("{name}", username)}
              </h2>
              <button type="button" className="pv-tip-close" onClick={onClose} aria-label="Close tip panel">
                <IconClose size={18} />
              </button>
            </div>
            <p className="pv-tip-sub">{t("tip.subtitle")}</p>

            <WalletConnect />

            <div className="pv-tip-cur-toggle" role="group" aria-label="Tip currency">
              {(["usd", "hbar"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`pv-tip-cur${currency === c ? " is-active" : ""}`}
                  aria-pressed={currency === c}
                  onClick={() => setCurrency(c)}
                >
                  {c === "usd" ? "USD" : "HBAR"}
                </button>
              ))}
            </div>
            <div className="pv-chip-row" role="group" aria-label={isHbar ? "Tip amount presets (HBAR)" : "Tip amount presets (USD)"}>
              {(isHbar ? TIP_PRESETS_HBAR : TIP_PRESETS_USD).map((p) => {
                const active = isHbar ? hbarInput === p : usd === p;
                return (
                  <button
                    key={p}
                    type="button"
                    className={`pv-chip${active ? " is-active" : ""}`}
                    aria-pressed={active}
                    onClick={() => (isHbar ? setHbarInput(p) : setUsd(p))}
                  >
                    {isHbar ? `${p} ℏ` : `$${p}`}
                  </button>
                );
              })}
            </div>
            <input
              className="pv-tip-input"
              value={isHbar ? hbarInput : usd}
              onChange={(e) =>
                isHbar
                  ? setHbarInput(normalizeTipInput(e.target.value))
                  : setUsd(normalizeTipInput(e.target.value))
              }
              inputMode="decimal"
              placeholder={isHbar ? "Custom HBAR amount" : "Custom USD amount"}
              aria-label={isHbar ? "Custom tip amount in HBAR" : "Custom tip amount in USD"}
            />

            {hbarAmt != null && (
              <>
                <div className="pv-tip-break">
                  <div className="pv-tip-break-row">
                    <span>{t("tip.youSend")}</span>
                    <span>{isHbar ? "" : "≈ "}{hbarAmt.toFixed(4)} HBAR</span>
                  </div>
                  <div className="pv-tip-break-row">
                    <span>{t("tip.creatorGets").replace("{name}", username)}</span>
                    <span>{isHbar ? "" : "≈ "}{(toCreatorAmt ?? 0).toFixed(4)} HBAR</span>
                  </div>
                  <div className="pv-tip-break-row">
                    <span>{t("tip.treasuryGets")}</span>
                    <span>{isHbar ? "" : "≈ "}{(treasuryAmt ?? 0).toFixed(4)} HBAR</span>
                  </div>
                  <div className="pv-tip-break-row pv-tip-break-fee">
                    <span>{t("tip.networkFee").replace("{fee}", NETWORK_FEE_HBAR)}</span>
                    <span>≈ {NETWORK_FEE_HBAR} HBAR</span>
                  </div>
                </div>
                <p className="pv-tip-break-note">
                  {t("tip.breakdownNote")
                    .replace("{hbar}", fmtHbarShort(hbarAmt))
                    .replace("{toCreator}", fmtHbarShort(toCreatorAmt ?? 0))
                    .replace("{name}", username)
                    .replace("{fee}", fmtHbarShort(treasuryAmt ?? 0))}
                </p>
                <details className="pv-tip-how">
                  <summary>How the 98/2 split works</summary>
                  <p>
                    Two public smart contracts on Hedera handle the money — anyone can inspect them.
                  </p>
                  <p>
                    <strong>The Registry</strong> links every blockpage name to its creator&apos;s wallet,
                    so your tip can only land in {username}&apos;s wallet.{" "}
                    <a href="https://hashscan.io/mainnet/contract/0.0.10854058" target="_blank" rel="noreferrer">
                      0.0.10854058
                    </a>
                  </p>
                  <p>
                    <strong>The Tips contract</strong> splits your payment in a single transaction: 98% goes
                    straight to the creator, 2% keeps Voicescape running. Nobody holds your money in
                    between.{" "}
                    <a href="https://hashscan.io/mainnet/contract/0.0.10854060" target="_blank" rel="noreferrer">
                      0.0.10854060
                    </a>
                  </p>
                </details>
              </>
            )}

            <button type="button" className="pv-tip-btn pv-tip-confirm-btn" onClick={tip} disabled={busy || confirmStatus === "confirming" || (!isHbar && !hbarPrice)}>
              <IconTip size={20} />
              {confirmStatus === "confirming"
                ? "Confirming on Hedera…"
                : busy
                  ? "Tipping…"
                  : !isHbar && !hbarPrice
                    ? "Loading price…"
                    : isHbar
                      ? t("tip.confirmCtaHbar").replace("{amount}", hbarValid ? String(hbarNum) : "0")
                      : t("tip.confirmCta").replace("{amount}", usdValid ? usdNum.toFixed(2) : "0.00")}
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

            <p className="pv-tip-approve" style={{ whiteSpace: "pre-line" }}>
              {t("tip.approveNote")}
            </p>
            <TaxNotice compact />

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
/* One-time claim congrats card — Buddy's page (/forge) only            */
/* ------------------------------------------------------------------ */

/**
 * Render the congrats body string with <b>…</b> pairs as real <b>
 * elements — never dangerouslySetInnerHTML (the string comes from our own
 * i18n dictionaries, but the rule is structural).
 */
function congratsBodyNodes(text: string): ReactNode {
  const out: ReactNode[] = [];
  const re = /<b>([\s\S]*?)<\/b>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <b key={i++}>{m[1]}</b>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function ClaimCongratsCard({ routeUsername }: { routeUsername: string }) {
  const { t } = useLanguage();
  const { account } = useWallet();
  const [claimed, setClaimed] = useState<string | null>(null);

  useEffect(() => {
    // Buddy's blockpage only — every other page renders nothing extra.
    if (routeUsername.toLowerCase() !== "forge") return;
    const flag = readClaimCongrats(Date.now(), account ?? undefined);
    if (flag && !flag.seen) {
      setClaimed(flag.username);
      // Show once ever: mark seen in the same post-render effect.
      markClaimCongratsSeen();
    }
  }, [routeUsername, account]);

  if (!claimed) return null;
  return (
    <div role="status" className="vs-congrats">
      <div className="vs-congrats-big" aria-hidden="true">
        🎉
      </div>
      <h2>{t("congrats.title")}</h2>
      <p>{congratsBodyNodes(t("congrats.body"))}</p>
      <a href={`/${encodeURIComponent(claimed)}`} className="vs-btn vs-btn-primary">
        {t("congrats.cta")}
      </a>
      <p className="vs-congrats-once">{t("congrats.once")}</p>
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
      <ClaimCongratsCard routeUsername={username} />
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
