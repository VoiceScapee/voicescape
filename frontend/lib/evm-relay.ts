/**
 * Minimal Hedera JSON-RPC relay client (read-only).
 *
 * The relay translates Ethereum JSON-RPC into Hedera requests, which lets
 * humans and agents that already speak EVM tooling (MetaMask, ethers,
 * viem, Hardhat, Foundry) read Hedera contracts without learning
 * Hedera-native wallets. Hedera mainnet chain id is 295.
 *
 * WHAT THIS IS AND IS NOT:
 * - This client performs READS only (eth_call, eth_getLogs,
 *   eth_getTransactionReceipt). It never signs or submits a transaction.
 * - It uses plain fetch for JSON-RPC on purpose: the deploy gate allows
 *   ethers only as an EVM calldata decoder, never as a chain connection,
 *   so no ethers provider is constructed here.
 * - The relay is NEVER the authority for money or reputation. A relay
 *   answer is a hint; the production proof is the mirror node
 *   (see lib/server/evm-verify.ts). Treat relay data as untrusted input
 *   until the mirror node corroborates it.
 * - ENDPOINT POLICY: the URL comes ONLY from NEXT_PUBLIC_HEDERA_RELAY_URL.
 *   There is deliberately NO built-in default. The free public relay
 *   (https://mainnet.hashio.io/api) is for development and low-volume
 *   reads only — it is throttled and not intended for production traffic.
 *   Production use requires a self-hosted relay or a managed provider,
 *   which is a cost decision for Brandon (see the 2026-10-22 EVM report),
 *   not something this client silently picks.
 */

export class RelayUnreachable extends Error {
  constructor(message = "Couldn't reach the Hedera JSON-RPC relay.") {
    super(message);
    this.name = "RelayUnreachable";
  }
}

export class RelayRpcError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "RelayRpcError";
    this.code = code;
  }
}

/**
 * Configured relay URL, or null when none is configured. Callers must
 * treat null as "EVM reads unavailable" — never fall back to a public
 * endpoint silently.
 */
export function getRelayUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_HEDERA_RELAY_URL?.trim();
  return url ? url : null;
}

interface JsonRpcErrorBody {
  code?: number;
  message?: string;
}

async function jsonRpc(
  url: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch {
    throw new RelayUnreachable();
  }
  if (!response.ok) throw new RelayUnreachable(`Relay responded ${response.status}.`);
  let body: { result?: unknown; error?: JsonRpcErrorBody };
  try {
    body = (await response.json()) as { result?: unknown; error?: JsonRpcErrorBody };
  } catch {
    throw new RelayUnreachable("Relay returned an unreadable response.");
  }
  if (body.error) {
    throw new RelayRpcError(body.error.message ?? "Relay RPC error.", body.error.code);
  }
  return body.result ?? null;
}

export interface EthCallInput {
  /** Contract address (0x…). */
  to: string;
  /** Calldata hex (0x…). */
  data: string;
  /** Optional caller address for the call. */
  from?: string;
  /** Block tag, default "latest". */
  block?: string;
  fetchImpl?: typeof fetch;
}

/** eth_call: run a view/pure function against a contract. Returns raw result hex. */
export async function relayEthCall(input: EthCallInput): Promise<string> {
  const url = getRelayUrl();
  if (!url) throw new RelayUnreachable("No Hedera relay URL is configured.");
  const callObject: Record<string, string> = { to: input.to, data: input.data };
  if (input.from) callObject.from = input.from;
  const result = await jsonRpc(
    url,
    "eth_call",
    [callObject, input.block ?? "latest"],
    input.fetchImpl ?? fetch,
  );
  if (typeof result !== "string") throw new RelayUnreachable("Relay eth_call returned no hex result.");
  return result;
}

export interface EthReceipt {
  transactionHash?: string;
  blockNumber?: string;
  status?: string;
  from?: string;
  to?: string;
  [key: string]: unknown;
}

/**
 * eth_getTransactionReceipt: secondary read path only. A receipt from the
 * relay proves the relay saw the transaction — it does NOT prove a payment
 * or mint for Voicescape purposes. Mirror-node verification
 * (lib/server/evm-verify.ts) is required before crediting anything.
 */
export async function relayGetTransactionReceipt(
  txHash: string,
  fetchImpl?: typeof fetch,
): Promise<EthReceipt | null> {
  const url = getRelayUrl();
  if (!url) throw new RelayUnreachable("No Hedera relay URL is configured.");
  const result = await jsonRpc(url, "eth_getTransactionReceipt", [txHash], fetchImpl ?? fetch);
  if (result === null) return null;
  if (typeof result !== "object") throw new RelayUnreachable("Relay receipt was not an object.");
  return result as EthReceipt;
}

export interface EthGetLogsInput {
  address?: string | string[];
  fromBlock?: string;
  toBlock?: string;
  topics?: (string | string[] | null)[];
  fetchImpl?: typeof fetch;
}

/** eth_getLogs: raw log read through the relay (secondary path; mirror node is the proof). */
export async function relayGetLogs(input: EthGetLogsInput): Promise<unknown[]> {
  const url = getRelayUrl();
  if (!url) throw new RelayUnreachable("No Hedera relay URL is configured.");
  const filter: Record<string, unknown> = {};
  if (input.address !== undefined) filter.address = input.address;
  if (input.fromBlock !== undefined) filter.fromBlock = input.fromBlock;
  if (input.toBlock !== undefined) filter.toBlock = input.toBlock;
  if (input.topics !== undefined) filter.topics = input.topics;
  const result = await jsonRpc(url, "eth_getLogs", [filter], input.fetchImpl ?? fetch);
  if (!Array.isArray(result)) throw new RelayUnreachable("Relay eth_getLogs did not return an array.");
  return result;
}
