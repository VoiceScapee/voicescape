/**
 * Tests for server-side EVM Transfer log verification.
 *
 * The happy-path log is the REAL log from the 2026-10-22 Hedera EVM
 * reference transaction (contract 0.0.10652328, mint to 0x76ae…):
 * topic0 = Transfer signature, from = zero address (a mint),
 * to = 0x76ae8867667b63ba3601fac4a18e35d2507fe4d6,
 * data = 0x0d592c32c5dea00 = 60,115,537,000,000,000 base units.
 */
import { describe, expect, it, vi } from "vitest";
import {
  EVM_TRANSFER_TOPIC0,
  decodeTransferLog,
  evaluateTipSentLogs,
  evaluateTransferLogs,
  verifyEvmTransfer,
  verifyTipSent,
  type MirrorContractLog,
} from "./evm-verify";
import { TIPSENT_TOPIC } from "../leaderboard";

const REFERENCE_LOG: MirrorContractLog = {
  contract_id: "0.0.10652328",
  topics: [
    EVM_TRANSFER_TOPIC0,
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    "0x00000000000000000000000076ae8867667b63ba3601fac4a18e35d2507fe4d6",
  ],
  data: "0x00000000000000000000000000000000000000000000000000d592c32c5dea00",
  timestamp: "1792690673.596140104",
  index: 2,
};

describe("decodeTransferLog", () => {
  it("decodes the reference mint log", () => {
    const decoded = decodeTransferLog(REFERENCE_LOG);
    expect(decoded).toEqual({
      from: "0x0000000000000000000000000000000000000000",
      to: "0x76ae8867667b63ba3601fac4a18e35d2507fe4d6",
      valueRaw: 60115537000000000n,
    });
  });

  it("rejects a non-Transfer topic0", () => {
    expect(
      decodeTransferLog({ ...REFERENCE_LOG, topics: ["0x" + "11".repeat(32), ...(REFERENCE_LOG.topics ?? []).slice(1)] }),
    ).toBeNull();
  });

  it("rejects short topics and malformed data", () => {
    expect(decodeTransferLog({ ...REFERENCE_LOG, topics: ["0x1234"] })).toBeNull();
    expect(decodeTransferLog({ ...REFERENCE_LOG, data: "0x1234" })).toBeNull();
    expect(decodeTransferLog(null)).toBeNull();
  });

  it("does not mistake an ERC-721 shape for a value transfer", () => {
    // ERC-721 Transfer: tokenId in a third topic, empty data.
    const erc721: MirrorContractLog = {
      topics: [
        EVM_TRANSFER_TOPIC0,
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x00000000000000000000000076ae8867667b63ba3601fac4a18e35d2507fe4d6",
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      ],
      data: "0x",
    };
    expect(decodeTransferLog(erc721)).toBeNull();
  });
});

describe("evaluateTransferLogs", () => {
  it("matches on all provided fields", () => {
    const result = evaluateTransferLogs([REFERENCE_LOG], {
      from: "0x0000000000000000000000000000000000000000",
      to: "0x76ae8867667b63ba3601fac4a18e35d2507fe4d6",
      valueRaw: "60115537000000000",
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("matched");
  });

  it("accepts hex expected values and partial expectations", () => {
    expect(
      evaluateTransferLogs([REFERENCE_LOG], { valueRaw: "0xd592c32c5dea00" }).ok,
    ).toBe(true);
    expect(evaluateTransferLogs([REFERENCE_LOG], { to: "0x76ae8867667b63ba3601fac4a18e35d2507fe4d6" }).ok).toBe(true);
  });

  it("reports no-matching-log on value mismatch and bad-input on bad addresses", () => {
    expect(evaluateTransferLogs([REFERENCE_LOG], { valueRaw: "1" }).reason).toBe("no-matching-log");
    expect(evaluateTransferLogs([REFERENCE_LOG], { to: "not-an-address" }).reason).toBe("bad-input");
  });
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

describe("verifyEvmTransfer", () => {
  it("verifies a matching log through a mocked mirror node", async () => {
    const fetchImpl = vi.fn(async (_url: unknown) => jsonResponse({ logs: [REFERENCE_LOG] }));
    const result = await verifyEvmTransfer({
      contractId: "0.0.10652328",
      expected: { to: "0x76ae8867667b63ba3601fac4a18e35d2507fe4d6", valueRaw: 60115537000000000n },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const url = String(fetchImpl.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("/api/v1/contracts/0.0.10652328/results/logs");
  });

  it("reports mirror-unreachable on HTTP errors and mirror-malformed on bad JSON", async () => {
    const httpFail = vi.fn(async () => jsonResponse({}, false));
    expect(
      (await verifyEvmTransfer({ contractId: "0.0.1", expected: {}, fetchImpl: httpFail as unknown as typeof fetch })).reason,
    ).toBe("mirror-unreachable");
    const badJson = vi.fn(async () => ({ ok: true, json: async () => { throw new Error("nope"); } }) as unknown as Response);
    expect(
      (await verifyEvmTransfer({ contractId: "0.0.1", expected: {}, fetchImpl: badJson as unknown as typeof fetch })).reason,
    ).toBe("mirror-malformed");
  });

  it("retries a failing fetch and then reports unreachable", async () => {
    const failing = vi.fn(async () => { throw new Error("down"); });
    const result = await verifyEvmTransfer({
      contractId: "0.0.1",
      expected: {},
      fetchImpl: failing as unknown as typeof fetch,
    });
    expect(result.reason).toBe("mirror-unreachable");
    expect(failing).toHaveBeenCalledTimes(3);
  });
});

function padTopic(address: string): string {
  return "0x" + "0".repeat(24) + address.slice(2).toLowerCase();
}

function word(value: bigint): string {
  return "0x" + value.toString(16).padStart(64, "0");
}

const TIP_FROM = "0x1111111111111111111111111111111111111111";
const TIP_TO = "0x2222222222222222222222222222222222222222";

function tipSentLog(gross = 10_000_000n, fee = 200_000n): MirrorContractLog {
  return {
    contract_id: "0.0.10854060",
    topics: [TIPSENT_TOPIC, padTopic(TIP_FROM), padTopic(TIP_FROM), padTopic(TIP_TO)],
    data: word(gross) + word(fee).slice(2),
    timestamp: "1791392670.082124104",
    index: 0,
  };
}

describe("verifyTipSent", () => {
  it("matches a TipSent log on from/to/gross and proves the 98/2 split words", () => {
    const result = evaluateTipSentLogs([tipSentLog()], {
      from: TIP_FROM,
      to: TIP_TO,
      grossTinybar: 10_000_000n,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("matched");
    // 2% fee word: fee * 50 === gross, so creator net is exactly 98%.
    expect(result.matched?.feeTinybar).toBe(200_000n);
    expect(result.matched!.feeTinybar * 50n).toBe(result.matched!.grossTinybar);
  });

  it("reports no-matching-log on gross mismatch and bad-input on bad addresses", () => {
    expect(evaluateTipSentLogs([tipSentLog()], { grossTinybar: 1n }).reason).toBe(
      "no-matching-log",
    );
    expect(evaluateTipSentLogs([tipSentLog()], { from: "nope" }).reason).toBe("bad-input");
  });

  it("verifies a matching TipSent through a mocked mirror node", async () => {
    const fetchImpl = vi.fn(async (_url: unknown) => jsonResponse({ logs: [tipSentLog()] }));
    const result = await verifyTipSent({
      contractId: "0.0.10854060",
      expected: { to: TIP_TO, grossTinybar: "10000000" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(result.matched?.grossTinybar).toBe(10_000_000n);
  });
});
