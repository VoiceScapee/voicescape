"use client";

/**
 * AssistantWalletBridge — the window bridge the agentic-web assistant uses
 * to sign tips with the visitor's own wallet.
 *
 * The assistant (public/site-actions.js, a static module) cannot import the
 * site's React wallet context, so this client component — mounted on /intros
 * inside RootProviders — registers window.__voicescapeAssistant with one
 * function: submitTip, which uses the exact TipBox path (useWallet →
 * getTxSender → tipPage). The assistant never touches keys: it asks the
 * bridge to sign, the wallet prompts, and the bridge returns the mirror
 * transaction id (or a plain refusal). No wallet connected means a refusal,
 * never a surprise connect prompt.
 */
import { useEffect } from "react";
import { useWallet } from "@/lib/wallet";
import { tipPage } from "@/lib/contracts";
import { hbarToWei } from "@/lib/tokens";

declare global {
  interface Window {
    __voicescapeAssistant?: {
      walletConnected: () => boolean;
      submitTip: (args: {
        username: string;
        amountHbar: number;
      }) => Promise<{ ok: boolean; txId?: string; reason?: string }>;
    };
  }
}

export default function AssistantWalletBridge() {
  const { account, getTxSender } = useWallet();

  useEffect(() => {
    window.__voicescapeAssistant = {
      walletConnected: () => account != null,
      submitTip: async ({ username, amountHbar }) => {
        if (!account) {
          return {
            ok: false,
            reason:
              "No wallet is connected — connect your wallet on this page, then ask again.",
          };
        }
        try {
          const sender = await getTxSender();
          const txId = await tipPage(username, hbarToWei(amountHbar), sender);
          return { ok: true, txId };
        } catch (e) {
          return {
            ok: false,
            reason:
              e instanceof Error ? e.message : "Wallet signing failed.",
          };
        }
      },
    };
    return () => {
      delete window.__voicescapeAssistant;
    };
  }, [account, getTxSender]);

  return null;
}
