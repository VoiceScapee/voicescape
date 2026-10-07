/**
 * submitPreparedTx fresh-pairing tests: a pairing approved seconds ago
 * skips the wallet-round-trip liveness probe (which a healthy wallet may
 * not answer — the 2026-10-07 HashPack-iOS false-"stale" failure) and goes
 * straight to the signature request. Aged pairings keep the probe+rewake
 * behavior.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("./wallet", () => ({
  getHederaPairing: vi.fn(),
  restoreHederaPairing: vi.fn(),
  rewakeHederaPairing: vi.fn(),
  isWalletSessionAlive: vi.fn(),
  isPairingFresh: vi.fn(),
  REWAKE_PROBE_TIMEOUT_MS: 8000,
  STALE_CONNECTION_COPY: "stale-test-copy",
}));

import {
  getHederaPairing,
  isWalletSessionAlive,
  rewakeHederaPairing,
  isPairingFresh,
} from "./wallet";
import {
  submitPreparedTx,
  StaleWalletPairingError,
} from "./prepared-tx";

const getHederaPairingMock = vi.mocked(getHederaPairing);
const isWalletSessionAliveMock = vi.mocked(isWalletSessionAlive);
const rewakeHederaPairingMock = vi.mocked(rewakeHederaPairing);
const isPairingFreshMock = vi.mocked(isPairingFresh);

const PAYLOAD = {
  transactionList: "dGVzdA==",
  signerAccountId: "hedera:mainnet:0.0.123",
  transactionId: "0.0.123@1700000000.000000001",
};

function livePairing() {
  return {
    hc: {
      signAndExecuteTransaction: vi.fn().mockResolvedValue({ txHash: "ok" }),
    },
    accountId: "0.0.123",
  };
}

function mockMirrorSuccess() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ transactions: [{ result: "SUCCESS" }] }),
    }),
  );
}

describe("submitPreparedTx connector this-binding (2026-10-07)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMirrorSuccess();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Regression: the real DAppConnector defines signAndExecuteTransaction
   * as a prototype method that calls this.request() internally. The old
   * code detached it (const f = hc.signAndExecuteTransaction; f(...)),
   * which threw "undefined is not an object (evaluating 'this.request')"
   * on iOS and the wallet never received the request (no popup).
   * This mock replicates the real shape — a class, not a vi.fn object.
   */
  class RealisticConnector {
    public signCalls: object[] = [];
    async request(_req: object): Promise<unknown> {
      return { txHash: "ok" };
    }
    async signAndExecuteTransaction(params: object): Promise<unknown> {
      this.signCalls.push(params);
      return this.request({ method: "signAndExecuteTransaction", params });
    }
  }

  it("keeps `this` bound when firing the signature request", async () => {
    const hc = new RealisticConnector();
    getHederaPairingMock.mockReturnValue({ hc, accountId: "0.0.123" } as never);
    isPairingFreshMock.mockReturnValue(true);

    const result = await submitPreparedTx(PAYLOAD, {
      expectedOwnerAccountId: "0.0.123",
    });

    expect(result.confirmed).toBe(true);
    expect(hc.signCalls).toHaveLength(1);
    expect(hc.signCalls[0]).toEqual({
      signerAccountId: PAYLOAD.signerAccountId,
      transactionList: PAYLOAD.transactionList,
    });
  });
});

describe("submitPreparedTx fresh-pairing probe skip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMirrorSuccess();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips the probe and signs immediately when the pairing is fresh", async () => {
    const pairing = livePairing();
    getHederaPairingMock.mockReturnValue(pairing as never);
    isPairingFreshMock.mockReturnValue(true);

    const result = await submitPreparedTx(PAYLOAD, {
      expectedOwnerAccountId: "0.0.123",
    });

    expect(result.confirmed).toBe(true);
    expect(isPairingFreshMock).toHaveBeenCalledWith(120_000);
    // The wallet-round-trip probe must NOT run for a fresh pairing —
    // this is the 2026-10-07 fix (false "stale" blocked the signature).
    expect(isWalletSessionAliveMock).not.toHaveBeenCalled();
    expect(rewakeHederaPairingMock).not.toHaveBeenCalled();
    expect(pairing.hc.signAndExecuteTransaction).toHaveBeenCalledWith({
      signerAccountId: PAYLOAD.signerAccountId,
      transactionList: PAYLOAD.transactionList,
    });
  });

  it("still probes aged pairings and throws stale when the probe and rewake both fail", async () => {
    const pairing = livePairing();
    getHederaPairingMock.mockReturnValue(pairing as never);
    isPairingFreshMock.mockReturnValue(false);
    isWalletSessionAliveMock.mockResolvedValue(false);
    rewakeHederaPairingMock.mockResolvedValue(null);

    await expect(
      submitPreparedTx(PAYLOAD, { expectedOwnerAccountId: "0.0.123" }),
    ).rejects.toBeInstanceOf(StaleWalletPairingError);

    expect(isWalletSessionAliveMock).toHaveBeenCalled();
    expect(rewakeHederaPairingMock).toHaveBeenCalled();
    expect(pairing.hc.signAndExecuteTransaction).not.toHaveBeenCalled();
  });

  it("signs aged pairings when the probe answers", async () => {
    const pairing = livePairing();
    getHederaPairingMock.mockReturnValue(pairing as never);
    isPairingFreshMock.mockReturnValue(false);
    isWalletSessionAliveMock.mockResolvedValue(true);

    const result = await submitPreparedTx(PAYLOAD, {
      expectedOwnerAccountId: "0.0.123",
    });

    expect(result.confirmed).toBe(true);
    expect(isWalletSessionAliveMock).toHaveBeenCalled();
    expect(rewakeHederaPairingMock).not.toHaveBeenCalled();
    expect(pairing.hc.signAndExecuteTransaction).toHaveBeenCalled();
  });
});
