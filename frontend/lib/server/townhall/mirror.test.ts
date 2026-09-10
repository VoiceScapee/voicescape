/** Dust-fee evaluation tests — pure logic, no network. */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import {
  clearConsumedDustFees,
  consumeDustFeeTx,
  evaluateDustFeeTransfer,
  isDustFeeTxConsumed,
  releaseDustFeeTx,
  reserveDustFeeTx,
} from "./mirror";
import { dustFeeTinybars } from "./topics";

const TREASURY = "0.0.999";
const FEE = 1000;

afterEach(async () => {
  await clearConsumedDustFees();
  vi.useRealTimers();
});

describe("evaluateDustFeeTransfer", () => {
  it("rejects a missing transaction record", () => {
    const r = evaluateDustFeeTransfer(null, TREASURY, FEE);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });

  it("rejects a failed transaction", () => {
    const r = evaluateDustFeeTransfer(
      { result: "INSUFFICIENT_TX_FEE", name: "CryptoTransfer", transfers: [] },
      TREASURY,
      FEE,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/did not succeed/);
  });

  it("rejects when the treasury got nothing", () => {
    const r = evaluateDustFeeTransfer(
      {
        result: "SUCCESS",
        name: "CryptoTransfer",
        transfers: [{ account: "0.0.123", amount: 5000 }],
      },
      TREASURY,
      FEE,
    );
    expect(r.ok).toBe(false);
    expect(r.receivedTinybars).toBe(0);
  });

  it("rejects an underpaid fee", () => {
    const r = evaluateDustFeeTransfer(
      {
        result: "SUCCESS",
        name: "CryptoTransfer",
        transfers: [
          { account: "0.0.111", amount: -999 },
          { account: TREASURY, amount: 999 },
        ],
      },
      TREASURY,
      FEE,
    );
    expect(r.ok).toBe(false);
    expect(r.receivedTinybars).toBe(999);
    expect(r.reason).toMatch(/need 1000/);
  });

  it("accepts an exact fee", () => {
    const r = evaluateDustFeeTransfer(
      {
        result: "SUCCESS",
        name: "CryptoTransfer",
        transfers: [
          { account: "0.0.111", amount: -1000 },
          { account: TREASURY, amount: 1000 },
        ],
      },
      TREASURY,
      FEE,
    );
    expect(r.ok).toBe(true);
    expect(r.receivedTinybars).toBe(1000);
  });

  it("accepts an overpaid fee", () => {
    const r = evaluateDustFeeTransfer(
      {
        result: "SUCCESS",
        name: "CryptoTransfer",
        transfers: [{ account: TREASURY, amount: 50_000 }],
      },
      TREASURY,
      FEE,
    );
    expect(r.ok).toBe(true);
    expect(r.receivedTinybars).toBe(50_000);
  });

  it("sums multiple transfers to the treasury", () => {
    const r = evaluateDustFeeTransfer(
      {
        result: "SUCCESS",
        name: "CryptoTransfer",
        transfers: [
          { account: TREASURY, amount: 600 },
          { account: "0.0.222", amount: 10 },
          { account: TREASURY, amount: 400 },
        ],
      },
      TREASURY,
      FEE,
    );
    expect(r.ok).toBe(true);
    expect(r.receivedTinybars).toBe(1000);
  });

  it("ignores negative (outgoing) entries for the treasury account", () => {
    const r = evaluateDustFeeTransfer(
      {
        result: "SUCCESS",
        name: "CryptoTransfer",
        transfers: [
          { account: TREASURY, amount: -5000 },
          { account: TREASURY, amount: 1000 },
        ],
      },
      TREASURY,
      FEE,
    );
    expect(r.ok).toBe(true);
    expect(r.receivedTinybars).toBe(1000);
  });
});

describe("dustFeeTinybars", () => {
  const ORIGINAL = process.env.DUST_FEE_TINYBARS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DUST_FEE_TINYBARS;
    else process.env.DUST_FEE_TINYBARS = ORIGINAL;
  });

  it("defaults to 2,000,000 tinybars (0.02 HBAR)", () => {
    delete process.env.DUST_FEE_TINYBARS;
    expect(dustFeeTinybars()).toBe(2_000_000);
  });

  it("is configurable via DUST_FEE_TINYBARS", () => {
    process.env.DUST_FEE_TINYBARS = "5000000";
    expect(dustFeeTinybars()).toBe(5_000_000);
  });

  it("ignores a non-numeric DUST_FEE_TINYBARS", () => {
    process.env.DUST_FEE_TINYBARS = "lots";
    expect(dustFeeTinybars()).toBe(2_000_000);
  });
});

describe("dust-fee sender binding", () => {
  const paidBy = (payerTxId: string | undefined) => ({
    result: "SUCCESS",
    name: "CryptoTransfer",
    transaction_id: payerTxId,
    transfers: [
      { account: "0.0.123", amount: -2000 },
      { account: TREASURY, amount: 2000 },
    ],
  });

  it("accepts when the tx payer matches the expected sender", () => {
    const r = evaluateDustFeeTransfer(paidBy("0.0.123@1694000000.000000000"), TREASURY, FEE, "0.0.123");
    expect(r.ok).toBe(true);
    expect(r.payer).toBe("0.0.123");
  });

  it("rejects a fee paid by a different wallet", () => {
    const r = evaluateDustFeeTransfer(paidBy("0.0.456@1694000000.000000000"), TREASURY, FEE, "0.0.123");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/paid by 0\.0\.456/);
    expect(r.reason).toMatch(/not by your wallet/);
  });

  it("rejects when the payer cannot be parsed from the tx record", () => {
    const r = evaluateDustFeeTransfer(paidBy(undefined), TREASURY, FEE, "0.0.123");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no parseable payer/);
  });

  it("skips the sender check when no expected sender is given (back-compat)", () => {
    const r = evaluateDustFeeTransfer(paidBy("0.0.456@1694000000.000000000"), TREASURY, FEE);
    expect(r.ok).toBe(true);
  });
});

describe("consumed dust-fee registry", () => {
  it("marks a tx id consumed and reports it", async () => {
    const txId = "0.0.123@1694000000.000000001";
    expect(await isDustFeeTxConsumed(txId)).toBe(false);
    await consumeDustFeeTx(txId);
    expect(await isDustFeeTxConsumed(txId)).toBe(true);
  });

  it("a consumed tx id is still consumed after 6 days", async () => {
    vi.useFakeTimers();
    try {
      const txId = "0.0.123@1694000000.000000002";
      await consumeDustFeeTx(txId);
      vi.advanceTimersByTime(6 * 24 * 3600 * 1000);
      expect(await isDustFeeTxConsumed(txId)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a consumed tx id expires after the 7-day TTL", async () => {
    vi.useFakeTimers();
    try {
      const txId = "0.0.123@1694000000.000000003";
      await consumeDustFeeTx(txId);
      vi.advanceTimersByTime(7 * 24 * 3600 * 1000 + 1);
      expect(await isDustFeeTxConsumed(txId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dust-fee in-flight reservations", () => {
  it("a reservation blocks a second concurrent reservation of the same tx id", async () => {
    const txId = "0.0.123@1694000000.000000004";
    expect(await reserveDustFeeTx(txId)).toBe(true);
    expect(await reserveDustFeeTx(txId)).toBe(false);
  });

  it("releasing a reservation makes the tx id usable again", async () => {
    const txId = "0.0.123@1694000000.000000005";
    expect(await reserveDustFeeTx(txId)).toBe(true);
    await releaseDustFeeTx(txId);
    expect(await reserveDustFeeTx(txId)).toBe(true);
  });

  it("a consumed tx id cannot be reserved", async () => {
    const txId = "0.0.123@1694000000.000000006";
    await consumeDustFeeTx(txId);
    expect(await reserveDustFeeTx(txId)).toBe(false);
  });

  it("consume converts a reservation into the permanent record", async () => {
    const txId = "0.0.123@1694000000.000000007";
    expect(await reserveDustFeeTx(txId)).toBe(true);
    await consumeDustFeeTx(txId);
    expect(await isDustFeeTxConsumed(txId)).toBe(true);
    expect(await reserveDustFeeTx(txId)).toBe(false);
  });

  it("a stale reservation expires after the in-flight TTL", async () => {
    vi.useFakeTimers();
    try {
      const txId = "0.0.123@1694000000.000000008";
      expect(await reserveDustFeeTx(txId)).toBe(true);
      expect(await reserveDustFeeTx(txId)).toBe(false);
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(await reserveDustFeeTx(txId)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RealMirrorPort sender resolution", () => {
  const SAVED_ENV = {
    treasury: process.env.NEXT_PUBLIC_TREASURY_ADDRESS,
    fee: process.env.DUST_FEE_TINYBARS,
    network: process.env.TOWNHALL_HCS_NETWORK,
  };
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_TREASURY_ADDRESS = "0.0.999";
    process.env.DUST_FEE_TINYBARS = "1000";
    process.env.TOWNHALL_HCS_NETWORK = "testnet";
  });
  afterEach(() => {
    for (const [k, v] of [
      ["NEXT_PUBLIC_TREASURY_ADDRESS", SAVED_ENV.treasury],
      ["DUST_FEE_TINYBARS", SAVED_ENV.fee],
      ["TOWNHALL_HCS_NETWORK", SAVED_ENV.network],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const txRecord = (payer: string) => ({
    transactions: [
      {
        result: "SUCCESS",
        name: "CryptoTransfer",
        transaction_id: `${payer}@1694000000.000000000`,
        transfers: [
          { account: payer, amount: -1000 },
          { account: "0.0.999", amount: 1000 },
        ],
      },
    ],
  });

  function mockMirror(opts: { txPayer: string; accountForEvm?: string | null }) {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/v1/accounts/")) {
        if (opts.accountForEvm === null) {
          return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({ account: opts.accountForEvm }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => txRecord(opts.txPayer) } as unknown as Response;
    }) as typeof fetch;
  }

  it("accepts a 0x session whose resolved account paid the fee", async () => {
    const { RealMirrorPort } = await import("./mirror");
    const evm = "0x0000000000000000000000000000000000000123";
    mockMirror({ txPayer: "0.0.291", accountForEvm: "0.0.291" });
    const r = await new RealMirrorPort().verifyDustFee("0.0.291@1694000000.000000000", evm);
    expect(r.ok).toBe(true);
  });

  it("rejects a 0x session whose resolved account did NOT pay the fee", async () => {
    const { RealMirrorPort } = await import("./mirror");
    const evm = "0x0000000000000000000000000000000000000456";
    mockMirror({ txPayer: "0.0.291", accountForEvm: "0.0.456" });
    const r = await new RealMirrorPort().verifyDustFee("0.0.291@1694000000.000000000", evm);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not by your wallet/);
  });

  it("compares a 0.0.x session directly against the tx payer", async () => {
    const { RealMirrorPort } = await import("./mirror");
    mockMirror({ txPayer: "0.0.291" });
    const r = await new RealMirrorPort().verifyDustFee("0.0.291@1694000000.000000000", "0.0.291");
    expect(r.ok).toBe(true);
  });

  it("rejects when the session wallet cannot be resolved to an account", async () => {
    const { RealMirrorPort } = await import("./mirror");
    mockMirror({ txPayer: "0.0.291", accountForEvm: null });
    const r = await new RealMirrorPort().verifyDustFee(
      "0.0.291@1694000000.000000000",
      "0x0000000000000000000000000000000000000999",
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not resolve your wallet/);
  });
});
