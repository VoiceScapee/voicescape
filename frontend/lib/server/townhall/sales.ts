/**
 * Voicescape Social Town Hall — proof-of-payment via completed direct sales.
 *
 * Reputation votes are proof-of-payment: a vote on a target page is only
 * valid when the voter's wallet has ≥1 COMPLETED on-chain purchase from the
 * target page's owner. "Completed" means the VoicescapeTips contract's
 * buyListing settled atomically (98% to seller, 2% to treasury) — there is
 * no escrow, so the PurchaseCompleted event IS the proof: it is emitted
 * only after both transfers succeed in the same transaction.
 *
 * The Tips contract is the source of truth: we index PurchaseCompleted
 * event logs from the mirror node for (buyer, seller) pairs. An HCS
 * message or log entry alone never grants eligibility.
 */

import { ethers } from "ethers";
import { mirrorBaseUrl } from "./topics";

export function getTipsAddress(): string | null {
  const addr = process.env.NEXT_PUBLIC_TIPS_ADDRESS;
  return addr && addr.trim() ? addr.trim() : null;
}

export interface SalesPort {
  /**
   * True when `buyer` (canonical 0x) has at least one completed on-chain
   * purchase from `seller` (canonical 0x). Throws on infrastructure failure
   * so callers can fail closed; returns false (not a throw) when the Tips
   * contract isn't deployed yet — then no completed purchase can exist.
   */
  hasCompletedPurchase(buyer: string, seller: string): Promise<boolean>;
}

/** keccak256("PurchaseCompleted(address,address,string,uint256,uint256)") — topics[0]. */
const PURCHASE_COMPLETED_TOPIC0 = ethers.id(
  "PurchaseCompleted(address,address,string,uint256,uint256)"
);
/** Cap on mirror-node log pages scanned per eligibility check. */
const MAX_LOG_PAGES = 5;

interface MirrorLogsResponse {
  logs?: { topics?: string[] }[];
  links?: { next?: string | null };
}

export class RealSalesPort implements SalesPort {
  async hasCompletedPurchase(buyer: string, seller: string): Promise<boolean> {
    const address = getTipsAddress();
    if (!address) return false; // tips contract not deployed → no completed purchase can exist
    const buyerNorm = buyer.toLowerCase();
    const sellerNorm = seller.toLowerCase();
    // PurchaseCompleted(buyer, seller, …): topics[0]=sig, topics[1]=buyer, topics[2]=seller.
    const topic1 = "0x" + buyerNorm.slice(2).padStart(64, "0");
    const topic2 = "0x" + sellerNorm.slice(2).padStart(64, "0");
    const params = new URLSearchParams({
      topic0: PURCHASE_COMPLETED_TOPIC0,
      topic1,
      topic2,
      order: "asc",
      limit: "100",
    });
    let url: string | null = `${mirrorBaseUrl()}/api/v1/contracts/${address}/results/logs?${params}`;
    for (let page = 0; page < MAX_LOG_PAGES && url; page++) {
      let res: Response;
      try {
        res = await fetch(url);
      } catch (e) {
        throw new Error(`mirror node unreachable: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) throw new Error(`mirror node error (${res.status}) reading sales logs`);
      const data = (await res.json()) as MirrorLogsResponse;
      // Any matching PurchaseCompleted log from the Tips contract is a
      // completed atomic sale: the event is only emitted after the 98/2
      // transfers succeed in the same transaction.
      if ((data.logs ?? []).length > 0) return true;
      const next = data.links?.next ?? null;
      url = next ? (next.startsWith("http") ? next : `${mirrorBaseUrl()}${next}`) : null;
    }
    return false;
  }
}

let salesSingleton: SalesPort | null = null;

export function defaultSalesPort(): SalesPort {
  if (!salesSingleton) salesSingleton = new RealSalesPort();
  return salesSingleton;
}
