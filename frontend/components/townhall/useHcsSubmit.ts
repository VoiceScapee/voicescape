"use client";

/**
 * React hook for user-signed HCS submits.
 *
 * Replaces the dust-fee flow: the user signs a TopicMessageSubmitTransaction
 * in their wallet (HashPack, etc.), paying the HCS fee directly. This is
 * transparent — the transaction appears on HashScan under their account.
 */

import { useCallback, useState } from "react";
import { getHederaPairing } from "@/lib/wallet";
import { getActiveChain } from "@/lib/chains";
import { submitHcsViaWallet, getTownhallTopics } from "@/lib/hcs-wallet";

export type HcsPhase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string };

export interface HcsSubmitFlow {
  phase: HcsPhase;
  /**
   * True once a submit has been waiting >15s (wallet slow/silent or network
   * lag). UIs show the reassurance copy so users don't abandon the page.
   */
  waitingLong: boolean;
  /**
   * Submit a message to an HCS topic via the user's wallet.
   * Returns the transaction ID on success, null on failure/cancel.
   */
  submit: (topicDomain: string, message: object) => Promise<string | null>;
  reset: () => void;
}

/**
 * Cache topic IDs to avoid refetching on every submit.
 */
let topicsCache: Record<string, string | null> | null = null;

export function useHcsSubmit(): HcsSubmitFlow {
  const [phase, setPhase] = useState<HcsPhase>({ kind: "idle" });
  const [waitingLong, setWaitingLong] = useState(false);

  const submit = useCallback(
    async (topicDomain: string, message: object): Promise<string | null> => {
      setPhase({ kind: "submitting" });
      setWaitingLong(false);
      // HashPack sometimes goes silent after the user approves (the message
      // still lands on-chain; the wallet layer recovers via the mirror node
      // after a 90s timeout). Without a progress hint the UI looks frozen —
      // reassure after 15s so users don't abandon the page.
      const waitingNote = setTimeout(() => setWaitingLong(true), 15000);
      try {
        // Get the wallet pairing
        const pairing = getHederaPairing();
        if (!pairing) {
          throw new Error("Connect a Hedera wallet (HashPack) to post.");
        }

        // Get topic IDs (cached)
        if (!topicsCache) {
          topicsCache = await getTownhallTopics();
        }
        const topicId = topicsCache[topicDomain];
        if (!topicId) {
          throw new Error(`Topic not configured for ${topicDomain}`);
        }

        // Network follows the active chain config (NEXT_PUBLIC_CHAIN) so
        // testnet builds submit to testnet instead of mainnet.
        const network = getActiveChain().key === "hedera-mainnet" ? "mainnet" : "testnet";

        const result = await submitHcsViaWallet(topicId, message, {
          signAndExecuteTransaction: pairing.hc.signAndExecuteTransaction.bind(pairing.hc),
          accountId: pairing.accountId,
          network,
        });

        setPhase({ kind: "idle" });
        return result.transactionId;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // User cancelled in wallet - don't show as error
        if (message.includes("cancel") || message.includes("reject")) {
          setPhase({ kind: "idle" });
          return null;
        }
        setPhase({ kind: "error", message });
        return null;
      } finally {
        clearTimeout(waitingNote);
        setWaitingLong(false);
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setPhase({ kind: "idle" });
    setWaitingLong(false);
  }, []);

  return { phase, waitingLong, submit, reset };
}
