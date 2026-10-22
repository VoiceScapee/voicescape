/**
 * Server-side verification of EVM contract events for Voicescape.
 *
 * WHY THIS EXISTS (2026-10-22, Hedera EVM reference transaction):
 * An EVM contract-ledger mint/transfer produces NO Hedera token_transfers
 * and NO HBAR transfers beyond the fee — it is visible ONLY in contract
 * logs. Any Voicescape feature that ever treats an EVM event as proof
 * (a tip, a sale, a mint) must verify the log server-side, never accept
 * a client-supplied receipt, screenshot, or log.
 *
 * VERIFICATION HIERARCHY (production):
 *   1. Mirror-node REST contract logs — the production proof (this file).
 *   2. Relay eth_getLogs / eth_getTransactionReceipt — a secondary read
 *      path only (see lib/evm-relay.ts). The relay submits and serves
 *      reads; it is NEVER the sole authority for money or reputation.
 * HTS token payments are verified separately through token_transfers
 * (see lib/server/townhall/mirror.ts for the dust-fee pattern) — do not
 * mix the two ledgers: an EVM log is not an HTS transfer and vice versa.
 *
 * READ-ONLY: this module never signs, sends, or submits anything. It
 * performs GET requests against the public mirror node only.
 */

const TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const EVM_TRANSFER_TOPIC0 = TRANSFER_TOPIC0;

/** A mirror-node contract log, with only the fields this module reads. */
export interface MirrorContractLog {
  contract_id?: string;
  topics?: string[];
  data?: string;
  timestamp?: string;
  index?: number;
  transaction_hash?: string;
}

export interface DecodedTransfer {
  /** 0x… 20-byte address, lowercase. */
  from: string;
  /** 0x… 20-byte address, lowercase. */
  to: string;
  /** Raw uint256 value as bigint (token base units — decimals are the token's own, not assumed here). */
  valueRaw: bigint;
}

export interface ExpectedTransfer {
  from?: string;
  to?: string;
  /** Base-unit amount; accepts bigint, decimal string, or hex string. */
  valueRaw?: bigint | string;
}

export interface TransferVerification {
  ok: boolean;
  /** Machine-readable reason when !ok: "matched" | "no-matching-log" | "mirror-unreachable" | "mirror-malformed" | "bad-input". */
  reason: string;
  matched?: DecodedTransfer;
}

function normalizeAddress(value: string | undefined | null): string | null {
  if (!value || typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(v)) return null;
  return v;
}

/** A 32-byte topic holding a padded address: the address is the last 40 hex chars. */
function topicToAddress(topic: string | undefined | null): string | null {
  if (!topic || typeof topic !== "string") return null;
  const t = topic.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(t)) return null;
  return normalizeAddress("0x" + t.slice(-40));
}

function parseUint256(data: string | undefined | null): bigint | null {
  if (!data || typeof data !== "string") return null;
  const d = data.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(d)) return null;
  try {
    return BigInt(d);
  } catch {
    return null;
  }
}

function parseExpectedValue(value: bigint | string): bigint | null {
  if (typeof value === "bigint") return value;
  const v = value.trim().toLowerCase();
  try {
    if (/^0x[0-9a-f]+$/.test(v)) return BigInt(v);
    if (/^\d+$/.test(v)) return BigInt(v);
  } catch {
    return null;
  }
  return null;
}

/**
 * Decode one mirror-node log as an ERC-20-style Transfer event.
 * Returns null unless the log is exactly: topic0 == Transfer signature,
 * topics[1] and topics[2] are padded addresses, data is one uint256.
 * (ERC-721 Transfers carry a tokenId in a third topic and empty data —
 * they are deliberately NOT decoded here; a future NFT-log helper must
 * handle that shape explicitly instead of misreading it as a value.)
 */
export function decodeTransferLog(log: MirrorContractLog | null | undefined): DecodedTransfer | null {
  if (!log) return null;
  const topics = log.topics ?? [];
  if (topics.length < 3) return null;
  if (topics[0]?.trim().toLowerCase() !== TRANSFER_TOPIC0) return null;
  const from = topicToAddress(topics[1]);
  const to = topicToAddress(topics[2]);
  const valueRaw = parseUint256(log.data);
  if (!from || !to || valueRaw === null) return null;
  return { from, to, valueRaw };
}

/**
 * Pure evaluation: find the first decoded log matching every expected
 * field that was provided. Fields left out of `expected` are not checked.
 */
export function evaluateTransferLogs(
  logs: MirrorContractLog[],
  expected: ExpectedTransfer,
): TransferVerification {
  const wantFrom = expected.from ? normalizeAddress(expected.from) : null;
  const wantTo = expected.to ? normalizeAddress(expected.to) : null;
  const wantValue =
    expected.valueRaw !== undefined ? parseExpectedValue(expected.valueRaw) : null;
  if (
    (expected.from && !wantFrom) ||
    (expected.to && !wantTo) ||
    (expected.valueRaw !== undefined && wantValue === null)
  ) {
    return { ok: false, reason: "bad-input" };
  }
  for (const log of logs) {
    const decoded = decodeTransferLog(log);
    if (!decoded) continue;
    if (wantFrom && decoded.from !== wantFrom) continue;
    if (wantTo && decoded.to !== wantTo) continue;
    if (wantValue !== null && decoded.valueRaw !== wantValue) continue;
    return { ok: true, reason: "matched", matched: decoded };
  }
  return { ok: false, reason: "no-matching-log" };
}

function mirrorBaseUrl(): string {
  const env = process.env.HEDERA_MIRROR_BASE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  return "https://mainnet.mirrornode.hedera.com/api/v1";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface VerifyEvmTransferInput {
  /** Hedera contract id (0.0.x) or EVM address. */
  contractId: string;
  expected: ExpectedTransfer;
  /** Mirror-node timestamp filter, e.g. "1792690673.596140104" — when set, only logs at/after it are fetched (via timestamp=gt:). */
  sinceTimestamp?: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch a contract's recent logs from the mirror node and assert that one
 * of them is the expected Transfer. Fetches the newest page (limit 100)
 * and asserts client-side regardless of any server-side filtering, so a
 * relay or proxy that strips filters cannot manufacture a match.
 * Never throws for verification outcomes: transport/parse problems are
 * reported as { ok: false, reason } so callers can say "couldn't verify"
 * instead of asserting an absence.
 */
export async function verifyEvmTransfer(
  input: VerifyEvmTransferInput,
): Promise<TransferVerification> {
  const contractId = input.contractId?.trim();
  if (!contractId) return { ok: false, reason: "bad-input" };
  const fetchImpl = input.fetchImpl ?? fetch;
  const params = new URLSearchParams({ limit: "100", order: "desc" });
  if (input.sinceTimestamp) params.set("timestamp", `gt:${input.sinceTimestamp}`);
  const url =
    `${mirrorBaseUrl()}/contracts/${encodeURIComponent(contractId)}/results/logs?${params.toString()}`;
  let response: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetchImpl(url, { headers: { accept: "application/json" } });
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(250 * (attempt + 1));
    }
  }
  if (!response) {
    void lastError;
    return { ok: false, reason: "mirror-unreachable" };
  }
  if (!response.ok) return { ok: false, reason: "mirror-unreachable" };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "mirror-malformed" };
  }
  const logs = (body as { logs?: MirrorContractLog[] }).logs;
  if (!Array.isArray(logs)) return { ok: false, reason: "mirror-malformed" };
  return evaluateTransferLogs(logs, input.expected);
}
