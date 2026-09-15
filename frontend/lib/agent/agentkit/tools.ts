/**
 * Voicescape plugin tools for the Hedera Agent Kit.
 *
 * Read-only chain tools for Blockpage Buddy: blockpage lookup, tip
 * verification, and treasury stats — all via the public Hedera mainnet
 * mirror node. Every tool is `TOOL_TYPE.QUERY`: none of them can sign,
 * spend, or publish anything. No operator key is used or needed.
 *
 * The request AbortSignal is threaded through the Agent Kit `Context`
 * (see `BuddyContext` in index.ts) so the route-level timeout still
 * applies to chain reads.
 */
import { TOOL_TYPE, type Context, type Tool } from "@hashgraph/hedera-agent-kit";
import {
  lookupBlockpageSchema,
  treasuryStatsSchema,
  verifyTipSchema,
} from "./schemas";
import {
  REGISTRY_EVM,
  RESOLVE_PAGE_SELECTOR,
  TIPS_ID,
  ZERO_ADDRESS,
  abi,
  evmAddressToAccountId,
  mirrorContractCall,
  mirrorGet,
  tinybarToHbar,
} from "./mirror";

export const LOOKUP_BLOCKPAGE_TOOL = "lookup_blockpage_tool";
export const VERIFY_TIP_TOOL = "verify_tip_tool";
export const TREASURY_STATS_TOOL = "treasury_stats_tool";

function signalOf(context: Context): AbortSignal | undefined {
  return (context as { signal?: AbortSignal } | undefined)?.signal;
}

// ---------------------------------------------------------------------------
// Tool 1: lookup_blockpage_tool
// ---------------------------------------------------------------------------

export function lookupBlockpageTool(_context: Context): Tool {
  return {
    method: LOOKUP_BLOCKPAGE_TOOL,
    name: "Lookup Blockpage",
    description:
      "Check whether a Voicescape blockpage username is registered on-chain. " +
      "Returns the owner account, owner type (HUMAN or AGENT), IPFS hash, " +
      "operator, and purpose. Read-only — never signs or spends.",
    parameters: lookupBlockpageSchema,
    toolType: TOOL_TYPE.QUERY,
    execute: async (_client, ctx, params) => {
      const signal = signalOf(ctx);
      const { username } = lookupBlockpageSchema.parse(params);
      const clean = username.slice(0, 64);
      const data =
        RESOLVE_PAGE_SELECTOR + abi.encode(["string"], [clean]).slice(2);
      let result: string;
      try {
        result = await mirrorContractCall(REGISTRY_EVM, data, signal);
      } catch (e: any) {
        // The Registry reverts on unknown usernames (CONTRACT_REVERT_EXECUTED,
        // surfaced by the mirror node as HTTP 400) — that means "not registered".
        if (String(e?.message ?? e).includes("CONTRACT_REVERT_EXECUTED")) {
          return JSON.stringify({
            registered: false,
            username: clean,
            ownerAccountId: null,
            ownerType: "UNKNOWN",
            ipfsHash: null,
            operatorEvmAddress: null,
            purpose: null,
          });
        }
        throw e;
      }
      const [owner, ipfsHash, ownerTypeRaw, operator, purpose] = abi.decode(
        ["address", "string", "uint8", "address", "string"],
        result
      ) as unknown as [string, string, bigint, string, string];

      const registered = owner.toLowerCase() !== ZERO_ADDRESS;
      const raw = Number(ownerTypeRaw);
      return JSON.stringify({
        registered,
        username: clean,
        ownerAccountId: registered ? evmAddressToAccountId(owner) : null,
        ownerEvmAddress: registered ? owner : null,
        ownerType: !registered
          ? "UNKNOWN"
          : raw === 1
            ? "AGENT"
            : raw === 0
              ? "HUMAN"
              : "UNKNOWN",
        ipfsHash: registered ? ipfsHash : null,
        operatorEvmAddress: registered ? operator : null,
        purpose: registered ? purpose : null,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 2: verify_tip_tool
// ---------------------------------------------------------------------------

/** Node fee-collection accounts — excluded when finding a tip recipient. */
const FEE_ACCOUNTS = new Set(["0.0.800", "0.0.801", "0.0.802", "0.0.98"]);

export function verifyTipTool(_context: Context): Tool {
  return {
    method: VERIFY_TIP_TOOL,
    name: "Verify Tip",
    description:
      "Verify a tip/payment transaction on Hedera mainnet. Reports whether " +
      "it succeeded, the HBAR amounts, the recipient account, and whether " +
      "the Voicescape Tips contract was called. Read-only — never signs or spends.",
    parameters: verifyTipSchema,
    toolType: TOOL_TYPE.QUERY,
    execute: async (_client, ctx, params) => {
      const signal = signalOf(ctx);
      const { transactionId } = verifyTipSchema.parse(params);
      const txBody = await mirrorGet(`/transactions/${transactionId}`, signal);
      const tx = txBody?.transactions?.[0];
      if (!tx) throw new Error(`transaction not found: ${transactionId}`);

      const transfers = (tx.transfers ?? []).map((t: any) => ({
        account: t.account,
        hbar: tinybarToHbar(t.amount),
      }));
      // Recipient = largest positive transfer that isn't a node fee account.
      const recipient = (tx.transfers ?? [])
        .filter(
          (t: any) =>
            Number(t.amount) > 0 && !FEE_ACCOUNTS.has(t.account)
        )
        .sort((a: any, b: any) => Number(b.amount) - Number(a.amount))[0];

      // Calldata isn't exposed on the transaction record; the contract-results
      // endpoint carries it. Best effort — never fails the tool.
      let functionSelector: string | null = null;
      let targetUsername: string | null = null;
      let amountSentHbar: number | null = null;
      let note: string | null = null;
      try {
        const cr = await mirrorGet(
          `/contracts/results/${transactionId}`,
          signal
        );
        if (
          cr?.function_parameters &&
          typeof cr.function_parameters === "string"
        ) {
          functionSelector = cr.function_parameters.slice(0, 10);
          try {
            const [decoded] = abi.decode(
              ["string"],
              "0x" + cr.function_parameters.slice(10)
            );
            targetUsername = decoded as string;
          } catch {
            targetUsername = null; // calldata isn't a single string arg — fine
          }
        }
        if (cr?.amount != null) amountSentHbar = tinybarToHbar(cr.amount);
      } catch {
        note = "contract-results lookup unavailable; selector/username omitted";
      }

      return JSON.stringify({
        transactionId,
        success: tx.result === "SUCCESS",
        result: tx.result,
        calledTipsContract: tx.entity_id === TIPS_ID,
        entityId: tx.entity_id ?? null,
        consensusTimestamp: tx.consensus_timestamp,
        amountSentHbar,
        functionSelector,
        targetUsername,
        recipientAccountId: recipient ? recipient.account : null,
        deliveredHbar: recipient ? tinybarToHbar(recipient.amount) : null,
        chargedFeeHbar: tinybarToHbar(tx.charged_tx_fee ?? 0),
        transfers,
        note,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 3: treasury_stats_tool
// ---------------------------------------------------------------------------

export function treasuryStatsTool(_context: Context): Tool {
  return {
    method: TREASURY_STATS_TOOL,
    name: "Treasury Stats",
    description:
      "Recent tip volume through the Voicescape Tips contract over a " +
      "lookback window in hours. Read-only — never signs or spends.",
    parameters: treasuryStatsSchema,
    toolType: TOOL_TYPE.QUERY,
    execute: async (_client, ctx, params) => {
      const signal = signalOf(ctx);
      const { hoursBack } = treasuryStatsSchema.parse(params);
      const window = Math.min(168, Math.max(1, Math.floor(hoursBack)));
      const nowSec = Math.floor(Date.now() / 1000);
      const fromSec = nowSec - window * 3600;
      // NOTE: account.id filtering does not match contract-call transactions
      // (the contract is not in the transfer list), so we use the contract
      // results endpoint. The `to` field there uses the long-zero address form
      // (0x0000...a59eac), not the contract's evm_address — compare by account id.
      const body = await mirrorGet(
        `/contracts/${TIPS_ID}/results?timestamp=gte:${fromSec}&limit=100&order=desc`,
        signal
      );
      const direct = (body?.results ?? []).filter(
        (r: any) =>
          typeof r.to === "string" && evmAddressToAccountId(r.to) === TIPS_ID
      );
      const selectors: Record<string, number> = {};
      let totalTinybar = 0;
      for (const r of direct) {
        totalTinybar += Number(r.amount ?? 0);
        const sel = String(r.function_parameters ?? "").slice(0, 10) || "unknown";
        selectors[sel] = (selectors[sel] ?? 0) + 1;
      }
      return JSON.stringify({
        windowHours: window,
        windowStart: new Date(fromSec * 1000).toISOString(),
        windowEnd: new Date(nowSec * 1000).toISOString(),
        directCalls: direct.length,
        totalHbar: tinybarToHbar(totalTinybar),
        selectors,
      });
    },
  };
}
