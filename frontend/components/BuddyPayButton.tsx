/**
 * BuddyPayButton — the in-chat 5-HBAR build payment control.
 *
 * Shown inside the Buddy widget when the build paywall appears. Drives the
 * EXISTING wallet tip flow: tipPage("forge") for exactly 5 HBAR
 * (BUILD_PRICE_TINYBAR), signed by the visitor's own wallet. No new money
 * code — same tipPage / resolvePage / TxSender path as the town-hall tip
 * buttons. Buddy never signs; the visitor approves in their own wallet.
 *
 * This widget mounts outside <WalletProvider>, so it uses the module-level
 * pairing helpers from "@/lib/wallet" instead of the useWallet() hook.
 */
"use client";

import { useState } from "react";
import {
  friendlyWalletError,
  getHederaPairing,
  restoreHederaPairing,
} from "@/lib/wallet";
import { getActiveChain } from "@/lib/chains";
import { resolvePage, tipPage } from "@/lib/contracts";
import { WalletTimeoutError } from "@/lib/tx";

/** 5 HBAR in wei (18 decimals) — must match BUILD_PRICE_TINYBAR server-side. */
export const BUILD_PAYMENT_WEI = 5_000_000_000_000_000_000n;

const BUDDY_PAGE_USERNAME = "forge";

type PayState =
  | "idle"
  | "checking"
  | "signing"
  | "submitted"
  | { error: string };

export default function BuddyPayButton({ onPaid }: { onPaid: () => void }) {
  const [state, setState] = useState<PayState>("idle");

  async function pay() {
    setState("checking");
    try {
      // Restore the visitor's wallet pairing (module-level — no provider).
      let pairing = getHederaPairing();
      if (!pairing) {
        const accountId = await restoreHederaPairing();
        pairing = accountId ? getHederaPairing() : null;
      }
      if (!pairing) {
        setState({
          error: "No wallet connected. Connect your wallet (top-right), then come back and tap Pay.",
        });
        return;
      }
      // Guardrail (same as the town-hall tip buttons): the contract reverts
      // for unregistered pages — never prompt a signature for a doomed tip.
      const registered = await resolvePage(BUDDY_PAGE_USERNAME, getActiveChain());
      if (!registered) {
        setState({
          error: "Buddy's forge page isn't registered on-chain — the payment would fail. Try again later.",
        });
        return;
      }
      // Dynamic import: ./tx pulls in @hiero-ledger/sdk (~2.3MB). Only load
      // it when actually signing — never on widget render.
      const { createHederaTxSender } = await import("@/lib/tx");
      const sender = createHederaTxSender(
        pairing.hc,
        pairing.accountId,
        getActiveChain()
      );
      setState("signing");
      try {
        await tipPage(BUDDY_PAGE_USERNAME, BUILD_PAYMENT_WEI, sender);
      } catch (e) {
        if (e instanceof WalletTimeoutError) {
          // Wallet went silent after approval — the money may have moved.
          // Never claim failure; treat as submitted and let the credit
          // check confirm on-chain.
        } else {
          throw e;
        }
      }
      setState("submitted");
      onPaid();
    } catch (e) {
      setState({ error: `Payment failed: ${friendlyWalletError(e)}` });
    }
  }

  const busy = state === "checking" || state === "signing";

  return (
    <div>
      <button
        type="button"
        onClick={() => void pay()}
        disabled={busy || state === "submitted"}
        style={{
          width: "100%",
          padding: "12px",
          borderRadius: 10,
          border: "none",
          cursor: busy || state === "submitted" ? "default" : "pointer",
          fontWeight: 700,
          fontSize: 14,
          color: "#fff",
          background:
            state === "submitted"
              ? "rgba(61, 220, 132, 0.25)"
              : "linear-gradient(135deg, #8259ef, #b45cf0)",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {state === "checking" && "Checking wallet…"}
        {state === "signing" && "Waiting for wallet approval…"}
        {state === "submitted" && "✓ Payment submitted"}
        {state === "idle" && "Pay 5 HBAR"}
        {typeof state === "object" && "Try again"}
      </button>
      <div style={{ marginTop: 6, fontSize: 11.5, color: "rgba(232, 234, 240, 0.6)", lineHeight: 1.5 }}>
        {state === "submitted"
          ? "Tip submitted — I'll detect it on-chain shortly (can take a minute). Nothing more to tap."
          : "One-time payment for your custom blockpage build. Sent to Buddy's forge page — 98/2 split enforced on-chain."}
      </div>
      {typeof state === "object" && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#ff9d9d", lineHeight: 1.5 }}>
          {state.error}
        </div>
      )}
    </div>
  );
}
