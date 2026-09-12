"use client";

/**
 * useConfirmedTransaction — reactive wrapper around pollTransactionStatus.
 *
 * Usage: pass the transaction id once the wallet has approved/signed it.
 * The hook reports "confirming" while the mirror node is polled, then a
 * terminal "confirmed" | "failed" | "timeout". Pass null (or unmount) to
 * reset to "idle".
 *
 * (For list UIs that track several pending transactions at once — comment
 * walls, forums — call pollTransactionStatus from lib/tx-confirm directly
 * instead of instantiating one hook per pending item.)
 */
import { useEffect, useState } from "react";
import { pollTransactionStatus, type TxPollOptions } from "@/lib/tx-confirm";

export type TxConfirmStatus = "idle" | "confirming" | "confirmed" | "failed" | "timeout";

export function useConfirmedTransaction(
  txId: string | null,
  opts?: TxPollOptions,
): TxConfirmStatus {
  const [status, setStatus] = useState<TxConfirmStatus>("idle");

  useEffect(() => {
    if (!txId) {
      setStatus("idle");
      return;
    }
    setStatus("confirming");
    const controller = new AbortController();
    let live = true;
    pollTransactionStatus(txId, { ...opts, signal: controller.signal })
      .then((outcome) => {
        if (live) setStatus(outcome);
      })
      .catch(() => {
        // Aborted (unmount or txId changed) — nothing to report.
      });
    return () => {
      live = false;
      controller.abort();
    };
    // Intentionally depends only on txId: callers must pass a stable opts
    // object (or none) so a re-render can't restart the poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txId]);

  return status;
}
